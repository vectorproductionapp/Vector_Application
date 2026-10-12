# GCP + Firebase blue/green deployment

Two independently releasable halves that share **one** Firebase project, **one**
Firestore database, **one** Storage bucket and **one** JWT secret:

| Half | Platform | Blue / Green mechanism |
| --- | --- | --- |
| React frontend (`src/`) | Firebase Hosting | preview channels → `hosting:clone` to `live` |
| Flask backend (`backend/`) | Cloud Run | new revision with `--no-traffic` → `update-traffic` |

```
Browser
  │
  ├─ static shell  ──►  Firebase Hosting   https://<site>.web.app          (live channel)
  │                                            └─ preview: https://<site>--<channel>-<hash>.web.app
  │
  ├─ REST  ──────────►  Cloud Run service  https://<service>-<project>.<region>.run.app
  │                       ├─ Blue  = revision at 100 % traffic
  │                       └─ Green = revision at   0 % traffic (verified only)
  │
  └─ WebSocket /ws ──►  same Cloud Run service (same host, same port)
                            │
                            └── Firestore + Firebase Storage in the same project
```

**Nothing in this repository deploys anything automatically.** Every script in
`scripts/` is invoked by a human, and the ones that move production traffic ask
for a typed confirmation first.

---

## Contents

1. [Required tools](#1-required-tools)
2. [Repository layout](#2-repository-layout)
3. [One-time GCP setup](#3-one-time-gcp-setup)
4. [Environment variables and secrets](#4-environment-variables-and-secrets)
5. [First deployment](#5-first-deployment)
6. [Backend: releasing a Green revision](#6-backend-releasing-a-green-revision)
7. [Frontend: preview, validation, promotion](#7-frontend-preview-validation-promotion)
8. [Preview validation checklist](#8-preview-validation-checklist)
9. [Rollback](#9-rollback)
10. [Logging and status](#10-logging-and-status)
11. [CORS and domains](#11-cors-and-domains)
12. [WebSockets](#12-websockets)
13. [Data compatibility rules (Firestore / Storage)](#13-data-compatibility-rules-firestore--storage)
14. [CI](#14-ci)
15. [Two pre-existing pipelines that bypass blue/green](#15-two-pre-existing-pipelines-that-bypass-bluegreen)
16. [What was changed and why](#16-what-was-changed-and-why)
17. [Assumptions](#17-assumptions)

---

## 1. Required tools

| Tool | Needed for | Check |
| --- | --- | --- |
| Google Cloud CLI (`gcloud`) | Cloud Run, Artifact Registry, Cloud Build, Secret Manager | `gcloud version` |
| Firebase CLI (`firebase`) | Hosting preview channels, `hosting:clone` | `firebase --version` (verified with 15.32.0) |
| Docker | building/pushing the backend image (`-Builder docker`) | `docker version` |
| Node.js + npm | building the React bundle | `node --version`, `npm --version` |
| PowerShell 5.1+ (or 7) | running every script in `scripts/` | `$PSVersionTable.PSVersion` |
| Git | source, image tags | `git --version` |

Sign in once:

```powershell
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_GCP_PROJECT_ID
npx firebase-tools login
```

> **Note:** if you use `-Builder cloudbuild` instead of `-Builder docker`, a
> local Docker daemon is not required.

---

## 2. Repository layout

```
scripts/
  common.ps1                     shared: native tool runs, HTTP probes, banners,
                                 confirmation gates, config-file loading
  gcp/
    common.ps1                   Cloud Run + state-file helpers (dot-sources ../common.ps1)
    config.example.ps1           -> copy to config.ps1 (git-ignored)
    cloudrun.env.yaml.example    -> copy to cloudrun.env.yaml (git-ignored)
    deploy-green.ps1             build + push + deploy --no-traffic + verify
    verify-green.ps1             /health (+ optional CORS preflight) against Green
    promote-green.ps1            send 100 % of traffic to Green   [asks "promote"]
    rollback.ps1                 send traffic back to the old revision [asks "rollback"]
    status.ps1                   read-only: traffic split, revisions, state, images
    .state/<service>.json        local, git-ignored: green / rollback bookkeeping
  firebase/
    common.ps1                   Firebase CLI + `npm ci && npm run build`
    config.example.ps1           -> copy to config.ps1 (git-ignored)
    deploy-preview.ps1           build + deploy to a preview channel + verify
    promote-live.ps1             hosting:clone <site>:<channel> <site>:live  [asks "live"]
    rollback-live.ps1            hosting:clone <site>@<version> <site>:live [asks "rollback"]
    .state/preview.json          local, git-ignored: last previewed channel
backend/
  Dockerfile                     Cloud Run image (gunicorn, non-root, $PORT)
  .dockerignore                  keeps every .env and *.json key out of the image
  .env.example                   placeholders for local development
tests/  (backend/tests/)         credential-free unit + smoke tests
.env.example                     frontend template (REACT_APP_* …)
firebase.json                    SPA rewrite + cache headers
.github/workflows/pr-checks.yml  build + test + image build, no credentials
```

### Configuration precedence

Every script parameter can come from three places:

```
script parameter  >  environment variable  >  scripts/<family>/config.ps1  >  built-in default
```

| Script parameter | Environment variable | Meaning |
| --- | --- | --- |
| `-ProjectId` | `VECTOR_GCP_PROJECT` | GCP project id |
| `-Region` | `VECTOR_GCP_REGION` | Cloud Run region (default `asia-south1`) |
| `-Service` | `VECTOR_GCP_SERVICE` | Cloud Run service name (default `vector-application`) |
| `-Repository` | `VECTOR_GCP_REPOSITORY` | Artifact Registry repo (default `cloud-run-source-deploy`) |
| `-Image` | `VECTOR_GCP_IMAGE` | image name (default `vector-api`) |
| `-Builder` | `VECTOR_GCP_BUILDER` | `docker` \| `cloudbuild` |
| `-SiteId` | `VECTOR_FIREBASE_SITE` | Firebase Hosting site id (default = project id) |
| `-ApiBaseUrl` | `REACT_APP_API_BASE_URL` | stable backend URL baked into the bundle |
| `-WsBaseUrl` | `REACT_APP_WS_BASE_URL` | optional dedicated WebSocket host |

Nothing secret is ever read from a file in this repository.

---

## 3. One-time GCP setup

All of the following are idempotent-ish and **non-destructive**; skip anything
already true for your project.

### 3.1 Enable APIs

```powershell
$PROJECT = "YOUR_GCP_PROJECT_ID"
$REGION  = "asia-south1"

gcloud config set project $PROJECT

gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  secretmanager.googleapis.com `
  iam.googleapis.com `
  iamcredentials.googleapis.com `
  firestore.googleapis.com `
  storage.googleapis.com
```

### 3.2 Artifact Registry repository

**Already done for this project — verified 2026-10-10.** The only repository in
`vector-production-506505` is `cloud-run-source-deploy` in `asia-south1`, so the
scripts push there and no repository has to be created:

```powershell
gcloud artifacts repositories list --project $PROJECT
# REPOSITORY               LOCATION
# cloud-run-source-deploy  asia-south1

gcloud auth configure-docker "$REGION-docker.pkg.dev"
```

Only if you ever want a dedicated repository instead, create one and point
`Repository` in `scripts/gcp/config.ps1` at it:

```powershell
gcloud artifacts repositories create vector-prod `
  --repository-format=docker `
  --region=$REGION `
  --description="Vector backend container images"
```

Images land at
`$REGION-docker.pkg.dev/$PROJECT/cloud-run-source-deploy/vector-api:<tag>` and
are **never deleted** by any script in this repository.

### 3.3 IAM roles for the deployer

> **Use the right account first — verified 2026-10-10.**
> This machine has several credentialed gcloud accounts and only **one** of them
> can see the project. A
> `Permission ... denied on resource '//cloudresourcemanager.googleapis.com/projects/<PROJECT>'`
> error means the *active account* is wrong, not that the resource is missing.
>
> Find the working account — it is the one `firebase-tools` is already logged in
> as — prove it can read Cloud Run, then point gcloud at it:
>
> ```powershell
> firebase login:list     # the account Firebase uses = the one with access
> gcloud auth list        # every locally credentialed account
>
> # prove access before switching (swap in the account from firebase login:list)
> gcloud run services list --account=<DEPLOYER_ACCOUNT> --project <PROJECT> --region asia-south1
>
> gcloud config set account <DEPLOYER_ACCOUNT>
> gcloud config set project  <PROJECT>
> # or per command:  gcloud ... --account=<DEPLOYER_ACCOUNT>
> ```
>
> Keeping gcloud and `firebase-tools` on the same account removes a whole class
> of "works in Firebase, denied in gcloud" confusion. The concrete account for
> this box is recorded in `scripts/gcp/config.ps1`, which is git-ignored — this
> repository is public, so addresses and project identifiers stay out of it.

The account that runs `scripts/gcp/*.ps1` and the Firebase scripts needs:

```powershell
$DEPLOYER = "user:you@example.com"

gcloud projects add-iam-policy-binding $PROJECT --member=$DEPLOYER --role="roles/run.admin"
gcloud projects add-iam-policy-binding $PROJECT --member=$DEPLOYER --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding $PROJECT --member=$DEPLOYER --role="roles/cloudbuild.builds.editor"
gcloud projects add-iam-policy-binding $PROJECT --member=$DEPLOYER --role="roles/secretmanager.secretAccessor"
gcloud projects add-iam-policy-binding $PROJECT --member=$DEPLOYER --role="roles/iam.serviceAccountUser"
gcloud projects add-iam-policy-binding $PROJECT --member=$DEPLOYER --role="roles/firebasehosting.admin"
```

* `run.admin` – create revisions, move traffic, read logs.
* `artifactregistry.writer` – push images.
* `cloudbuild.builds.editor` – only for `-Builder cloudbuild`.
* `secretmanager.secretAccessor` – read the secrets you attach.
* `iam.serviceAccountUser` – act as the runtime service account when deploying.
* `firebasehosting.admin` – Hosting preview channels and `hosting:clone`.

### 3.4 Runtime service account (data access)

**Verified 2026-10-10 — this project does NOT use the default Compute service
account.** The service runs as the Firebase Admin SDK service account:

```text
firebase-adminsdk-fbsvc@vector-production-506505.iam.gserviceaccount.com
```

```powershell
gcloud run services describe vector-application --project $PROJECT `
  --region $REGION --format='value(spec.template.spec.serviceAccountName)'
```

Its project-level roles today:

| Role | Why |
| --- | --- |
| `roles/firebase.sdkAdminServiceAgent` | Firebase Admin SDK / Firestore access |
| `roles/storage.admin` | reads and writes `FIREBASE_STORAGE_BUCKET` |
| `roles/iam.serviceAccountTokenCreator` | signs identity tokens |

**Do not change this identity.** Production already reads and writes Firestore
and Storage through it, so swapping it without carrying the equivalent roles
across will break the app silently (the `/health` probe still returns 200,
because `/health` touches no data). No key file is used — Cloud Run supplies
Application Default Credentials, which is why `GOOGLE_APPLICATION_CREDENTIALS`
stays unset.

If you ever move to the default Compute service account instead, grant it:

```powershell
$PROJECT_NUMBER = (gcloud projects describe $PROJECT --format='value(projectNumber)')
$RUNTIME_SA = "serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT --member=$RUNTIME_SA --role="roles/datastore.user"

gcloud storage buckets add-iam-policy-binding gs://YOUR_GCP_PROJECT_ID.firebasestorage.app `
  --member=$RUNTIME_SA --role="roles/storage.objectAdmin"
```

If you use a dedicated runtime service account, pass it with
`gcloud run deploy --service-account=...` once; Cloud Run remembers it for every
later revision, so Blue and Green share it.

### 3.5 Firebase project association

`.firebaserc` (git-ignored) maps the default project. The committed template is
`.firebaserc.example`.

```powershell
npx firebase-tools login
firebase projects:list
firebase hosting:sites:list --project $PROJECT
```

The default Hosting site id equals the Firebase project id; that value is what
`-SiteId` / `VECTOR_FIREBASE_SITE` default to.

### 3.6 Secrets in Google Secret Manager

Create each secret from a temporary file that you delete immediately. **Never
put the value in this repository.**

```powershell
# JWT_SECRET must be >= 32 bytes and must be IDENTICAL for Blue and Green,
# otherwise every session breaks on promote/rollback.
# Use a CSPRNG - Get-Random is a PRNG and must not generate a signing key.
$b = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($b); $rng.Dispose()
$hex = -join ($b | ForEach-Object { $_.ToString("x2") })
Set-Content -Path .\.jwt.tmp -Value $hex -NoNewline
gcloud secrets create jwt-secret --data-file=.\.jwt.tmp
Remove-Item .\.jwt.tmp
```

(or `openssl rand -hex 32 > .jwt.tmp` if you prefer — anything with a real
CSPRNG; 32 bytes → 64 hex characters.)

```powershell
# The others follow the same pattern:
gcloud secrets create password-reset-secret --data-file=.\.tmp1
gcloud secrets create msgraph-client-secret --data-file=.\.tmp2
gcloud secrets create smtp-password        --data-file=.\.tmp3
Remove-Item .\.tmp1, .\.tmp2, .\.tmp3

# The runtime service account must be able to read them.
foreach ($s in @("jwt-secret","password-reset-secret","msgraph-client-secret","smtp-password")) {
  gcloud secrets add-iam-policy-binding $s --member=$RUNTIME_SA --role="roles/secretmanager.secretAccessor"
}
```

### 3.7 Two pipelines that currently bypass blue/green

Read [§15](#15-two-pre-existing-pipelines-that-bypass-bluegreen) before your
first release — otherwise a push to `main` silently redeploys production.

---

## 4. Environment variables and secrets

Blue and Green are two revisions of **one Cloud Run service**, so they inherit
the *same* service-level configuration. That is what guarantees a shared
`JWT_SECRET`, the same `FIREBASE_STORAGE_BUCKET` and the same Firestore project
across a promote or a rollback.

### 4.1 Non-secret environment variables

Template: [`scripts/gcp/cloudrun.env.yaml.example`](../scripts/gcp/cloudrun.env.yaml.example)
(copy to `scripts/gcp/cloudrun.env.yaml`, which is git-ignored).

```powershell
Copy-Item scripts\gcp\cloudrun.env.yaml.example scripts\gcp\cloudrun.env.yaml
# edit cloudrun.env.yaml, then:

gcloud run services update vector-application --region $REGION --project $PROJECT `
  --env-vars-file=scripts\gcp\cloudrun.env.yaml
```

> `--env-vars-file` **replaces** every environment variable on the service, so
> list every non-secret key you need in that file. It is used instead of
> `--update-env-vars` because `--update-env-vars` splits on commas and
> `CORS_ORIGINS` is a comma-separated list. For an ad-hoc update that must keep
> commas, use gcloud's escaping form — the same one this repository's
> `cloudbuild.yaml` (line 8) already uses:
> `--update-env-vars=^@^CORS_ORIGINS=https://a,https://b@APP_ENV=production`
> (`^<delimiter>^<value>` splits on `<delimiter>`; here `@`.)

| Key | Required | Notes |
| --- | --- | --- |
| `APP_ENV=production` | ✔ | selects production behaviour in `backend/app.py` |
| `DEBUG` | ✔ | `"false"` in production |
| `PORT` | optional | Cloud Run injects it anyway; `8080` default |
| `CORS_ORIGINS` | ✔ | comma-separated **exact** origins, never `*` |
| `CORS_ALLOW_PREVIEW_CHANNELS` | optional | `true` to allow this project's preview URLs (§11) |
| `FIREBASE_SITE_ID` / `FIREBASE_PROJECT_ID` | with the above | the globally unique site id used in the preview pattern |
| `FIREBASE_STORAGE_BUCKET` | ✔ | e.g. `YOUR_PROJECT_ID.firebasestorage.app` |
| `JWT_EXPIRY_HOURS` | optional | default `8` |
| `MAIL_PROVIDER` | ✔ | `microsoft_graph` (default) or `smtp` |
| `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_SENDER_EMAIL` | Graph | client **secret** is a Secret Manager ref |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_FROM_EMAIL`, `SMTP_USE_TLS`, `SMTP_USE_SSL` | SMTP | password is a Secret Manager ref |
| `PASSWORD_RESET_OTP_MINUTES` … `PASSWORD_RESET_MAX_ATTEMPTS` | optional | defaults shown in the template |
| `APP_FRONTEND_URL` | ✔ | canonical origin used in reset e-mails |
| `EMAIL_LOGO_URL` / `EMAIL_LOGO_PATH` | optional | artwork inside the e-mail |
| `WEB_CONCURRENCY`, `GUNICORN_THREADS`, `GUNICORN_TIMEOUT` | optional | see `backend/Dockerfile`; keep `WEB_CONCURRENCY=1` |

### 4.2 Secrets

| Secret Manager id | Environment variable it fills |
| --- | --- |
| `jwt-secret` | `JWT_SECRET` |
| `password-reset-secret` | `PASSWORD_RESET_SECRET` |
| `msgraph-client-secret` | `MICROSOFT_CLIENT_SECRET` |
| `smtp-password` | `SMTP_PASSWORD` |

```powershell
gcloud run services update vector-application --region $REGION --project $PROJECT `
  --update-secrets="JWT_SECRET=jwt-secret:latest,PASSWORD_RESET_SECRET=password-reset-secret:latest,MICROSOFT_CLIENT_SECRET=msgraph-client-secret:latest,SMTP_PASSWORD=smtp-password:latest"
```

`--update-secrets` merges, so it is safe to run after `--env-vars-file`.

### 4.3 Firebase / Google application credentials

**There is no key file.** Cloud Run provides Application Default Credentials
from the runtime service account, and `backend/.dockerignore` excludes every
`*.json`, every `.env*` and every `*firebase-adminsdk-*.json` from the image,
so a locally saved service-account key can never ship.

Only a **local, non-Cloud Run** run would ever set:

```
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json
FIREBASE_CREDENTIALS_PATH=/absolute/path/to/key.json
```

> ⚠️ `firestore.client()` resolves credentials at import time, so the container
> exits during boot if ADC is unavailable. In Cloud Run ADC always exists, so
> this is fine — but it is why the pull-request CI never starts the container
> with the app, and why a locally run container needs either ADC or a key file.

### 4.4 Readiness probe (recommended, one time)

```powershell
gcloud run services update vector-application --region $REGION --project $PROJECT `
  --startup-probe="httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=5,failureThreshold=12,timeoutSeconds=3"
```

Cloud Run will not route traffic to a revision that never answers `/health`.
`deploy-green.ps1 -StartupProbe` sets the same probe on new revisions.

---

## 5. First deployment

```powershell
# 1. one-time local configuration (all three are git-ignored)
Copy-Item scripts\gcp\config.example.ps1         scripts\gcp\config.ps1
Copy-Item scripts\gcp\cloudrun.env.yaml.example  scripts\gcp\cloudrun.env.yaml
Copy-Item scripts\firebase\config.example.ps1    scripts\firebase\config.ps1
#    ...edit each: ProjectId, Region, Service, Repository, SiteId, ApiBaseUrl

# 2. build + push a uniquely tagged image and create revision #1 with NO traffic
.\scripts\gcp\deploy-green.ps1 `
    -Tag "v1" `
    -EnvVarsFile scripts\gcp\cloudrun.env.yaml `
    -Secret "JWT_SECRET=jwt-secret:latest" `
    -Secret "PASSWORD_RESET_SECRET=password-reset-secret:latest" `
    -Secret "MICROSOFT_CLIENT_SECRET=msgraph-client-secret:latest" `
    -Secret "SMTP_PASSWORD=smtp-password:latest" `
    -StartupProbe

# 3. (optional, but recommended) attach the probe / env to a service that
#    already exists
#    gcloud run services update vector-application --region asia-south1 --env-vars-file=scripts\gcp\cloudrun.env.yaml

# 4. verify + promote
.\scripts\gcp\verify-green.ps1
.\scripts\gcp\promote-green.ps1          # type:  promote
```

`deploy-green.ps1` prints the Green revision name and URL, runs
`GET <green-url>/health` for you, and **leaves production traffic untouched**.

Then the frontend:

```powershell
.\scripts\firebase\deploy-preview.ps1    # prints a preview URL
# validate it (§8), then:
.\scripts\firebase\promote-live.ps1 -ChannelId <channel>   # type:  live
```

---

## 6. Backend: releasing a Green revision

```powershell
# 1-5. build, push, deploy --no-traffic, print Green, GET /health
.\scripts\gcp\deploy-green.ps1
```

Optional extras:

```powershell
.\scripts\gcp\deploy-green.ps1 -Builder cloudbuild            # build in Cloud Build
.\scripts\gcp\deploy-green.ps1 -Tag release-20261010          # explicit image tag
.\scripts\gcp\deploy-green.ps1 -SkipVerify                    # skip the /health call
.\scripts\gcp\deploy-green.ps1 -Private                       # no allUsers invoker grant
.\scripts\gcp\deploy-green.ps1 -EnvVar "DEBUG=false"          # ad-hoc, comma-free KEY=VALUE
.\scripts\gcp\deploy-green.ps1 -Secret "JWT_SECRET=jwt-secret:latest"
```

Verification can be run on its own, any time:

```powershell
.\scripts\gcp\verify-green.ps1
.\scripts\gcp\verify-green.ps1 -Revision vector-application-00042-abc
.\scripts\gcp\verify-green.ps1 -Url https://vector-application-00042-abc-uc.a.run.app
.\scripts\gcp\verify-green.ps1 -CorsOrigin https://YOUR_GCP_PROJECT_ID.web.app
.\scripts\gcp\verify-green.ps1 -Retries 20 -RetryDelaySeconds 5
```

Exit code is `0` only when `/health` answered `200 {"status":"ok"}`, so it can
gate a pipeline.

### Promote (the only command that moves backend production traffic)

```powershell
.\scripts\gcp\promote-green.ps1
# type:  promote
```

It re-verifies `/health` first (unless `-SkipVerify`), records the currently
live revision as the rollback target, then runs:

```powershell
gcloud run services update-traffic vector-application `
  --to-revisions <GREEN_REVISION>=100 `
  --region asia-south1 --project YOUR_GCP_PROJECT_ID
```

Use `-Percent 10` for a deliberate canary — Green then owns 10 % and Blue 90 %.

---

## 7. Frontend: preview, validation, promotion

### 7.1 Deploy a preview (never touches `live`)

```powershell
.\scripts\firebase\deploy-preview.ps1
.\scripts\firebase\deploy-preview.ps1 -ChannelId green-20261010-153000
.\scripts\firebase\deploy-preview.ps1 -ApiBaseUrl https://<green-revision-url>   # point at Green
```

What it does:

1. `npm ci`
2. `npm run build` with `REACT_APP_API_BASE_URL` (and optional
   `REACT_APP_WS_BASE_URL`) inlined — CRA bakes these into the bundle at build
   time, which is why preview and live can target different backends.
3. `firebase hosting:channel:deploy <channel> --expires 7d`
4. prints `https://<site>--<channel>-<hash>.web.app`
5. verifies `GET <api>/health` and `GET <preview-url>`

Preview channels live in the **same** Firebase project, so they read and write
real production data. That is intentional for validation, and is exactly why
the script never promotes anything.

### 7.2 Promote to live (byte-exact, no rebuild)

```powershell
.\scripts\firebase\promote-live.ps1 -ChannelId <channel>
# type:  live
```

It runs:

```powershell
firebase hosting:clone <site>:<channel> <site>:live --project <project>
```

`hosting:clone` moves the **exact Hosting version** that was deployed to the
preview channel onto the live channel — no rebuild, no re-upload, so the bytes
you validated are the bytes that go live.

Nothing in `.github/workflows/` calls this script.

### 7.3 Record the version id

`promote-live.ps1` reads the version **for** you and prints it, because that is
the argument `-VersionId` needs:

```
  version  : clieab12cd34   <- what is live now
  previous : clie99ff00aa   <- rollback target
```

It also writes them to the git-ignored `scripts/firebase/.state/live.json`, and
`rollback-live.ps1` prints them again when you run it without arguments.

If the lookup comes back empty (permissions, or an unexpected site), fall back
to:

```powershell
# current version of each channel -> channels[].release.version.name
firebase hosting:channel:list --site <site> --project <project> --json
```

or Firebase console → **Hosting → Release history** → the release's version
(the console is the only place with the *full* history; the CLI has no
`hosting:releases:list`).

> ⚠️ **The separator matters.** `firebase hosting:clone` splits the source on
> `:` **first**, so `<site>:<x>` is *always* treated as a channel. A version id
> must be written `<site>@<version>`.

---

## 8. Preview validation checklist

Run against the printed preview URL **before** `promote-live.ps1`.

**Frontend shell**

- [ ] `GET <preview-url>` returns `200` and the app renders (not a blank page)
- [ ] `GET <preview-url>/asset-manifest.json` is `no-cache`
- [ ] response headers: `index.html` → `no-cache, no-store, must-revalidate`;
      `static/**` → `public, max-age=31536000, immutable`
- [ ] no `404` for JS/CSS (would mean a stale cached `index.html`)

**API wiring (the failure mode that broke login once already)**

- [ ] DevTools → Network: the login request goes to
      `https://<cloud-run-host>/login`, **not** to `<preview-url>/login`
- [ ] a relative API path in the bundle would be rewritten by Firebase Hosting
      to `index.html` — that must not happen
- [ ] `POST /login` answers `401 application/json` with bad credentials (never
      HTML)

**Live updates (WebSocket)**

- [ ] the live-update indicator shows connected
- [ ] a save in one tab refreshes another open tab
- [ ] DevTools → Network → `/ws` → Status `101`, no CORS/origin error
- [ ] if the socket does not connect, check `REACT_APP_WS_BASE_URL` /
      `REACT_APP_API_BASE_URL` on that bundle

**CORS / security**

- [ ] console has no `blocked by CORS policy` messages
- [ ] a disallowed origin does **not** receive
      `Access-Control-Allow-Origin: *`

**Backend (if you pointed the preview at a Green revision)**

- [ ] `verify-green.ps1 -CorsOrigin https://<site>.web.app` passes
- [ ] a write (save an invoice, edit a BOQ row) succeeds

**Data**

- [ ] expected rows load; attachments/images resolve
- [ ] confirm in Firebase console that you are looking at the intended project

---

## 9. Rollback

### 9.1 Backend — move traffic back, no rebuild

```powershell
# find the revisions and the current split
.\scripts\gcp\status.ps1

# preferred: the target recorded automatically at promote time
.\scripts\gcp\rollback.ps1
# type:  rollback

# explicit (needed if the local state file is missing)
.\scripts\gcp\rollback.ps1 -Revision <BLUE_REVISION>
```

Under the hood:

```powershell
gcloud run services update-traffic vector-application `
  --to-revisions <PREVIOUSLY_LIVE_REVISION>=100 `
  --region asia-south1 --project YOUR_GCP_PROJECT_ID
```

* No image is built, none is pulled from a registry, and **no revision or
  Artifact Registry image is ever deleted** — that is what makes the rollback
  instant.
* If the target does not answer `/health`, the script stops and suggests
  `-SkipVerify` for emergencies.
* Running it twice toggles back to the revision you just rolled away from.

### 9.2 Frontend — clone an older Hosting version back to live

```powershell
# promote-live.ps1 recorded these for you (also in scripts/firebase/.state/live.json):
#   current  -> what is live now
#   previous -> the rollback target
.\scripts\firebase\rollback-live.ps1 -VersionId <PREVIOUS_VERSION_ID>
# type:  rollback
```

`-VersionId` takes a Hosting **version** id (`clie…`), and the script builds the
source as `<site>@<version>` — note the **`@`**, because `firebase hosting:clone`
treats `<site>:<x>` as a *channel* (see `hosting-clone.js`: it splits on `:`
first and only falls back to `@`).

To find a version id:

```powershell
# current version of each channel -> channels[].release.version.name
firebase hosting:channel:list --site <site> --project <project> --json
```

…or, for the full history, Firebase console → **Hosting → Release history**.

Or roll live back to whatever a known-good preview channel currently holds (this
one uses `:`):

```powershell
.\scripts\firebase\rollback-live.ps1 -ChannelId <PREVIEW_CHANNEL>
```

Alternatively, in the Firebase console: **Hosting → Release history → Rollback**
(the console path is the fastest in an incident).

`rollback-live.ps1` prints its instructions — including the version recorded by
the last promotion — and exits `1` if neither `-VersionId` nor `-ChannelId` is
given; it never guesses a version. Hosting keeps every release, so a rollback is
itself reversible: after rolling back the script prints the version it just
replaced, and re-running with that id undoes the rollback.

Because `index.html` is served `no-cache`, a rollback is visible on the next
navigation without cache-busting tricks.

---

## 10. Logging and status

```powershell
# local blue/green bookkeeping only (no gcloud call)
.\scripts\gcp\status.ps1 -LocalOnly

# service URL, traffic split, newest revisions, state file
.\scripts\gcp\status.ps1
.\scripts\gcp\status.ps1 -Limit 25 -ShowImages

gcloud run services describe vector-application --region asia-south1 --project YOUR_GCP_PROJECT_ID
gcloud run services describe vector-application --format='value(status.traffic)'

gcloud run revisions list --service vector-application --region asia-south1 `
  --sort-by=~metadata.creationTimestamp --limit 15

gcloud run revisions describe <REVISION> --region asia-south1 --format='value(status.url)'

# logs (read-only, never deletes)
gcloud logging read `
  'resource.type="cloud_run_revision" AND resource.labels.service_name="vector-application"' `
  --project YOUR_GCP_PROJECT_ID --limit 100 --freshness=1h

# images kept in Artifact Registry (listing only)
gcloud artifacts docker images list asia-south1-docker.pkg.dev/YOUR_GCP_PROJECT_ID/cloud-run-source-deploy `
  --include-tags --limit 20
```

---

## 11. CORS and domains

`backend/__init__.py` builds an **exact-origin** list. Flask-CORS treats a value
as a regular expression only if it contains `* \ ] ? $ ^ [ (`, so plain origins
are matched literally and case-insensitively. A wildcard is never used.

### Allowed origins

| Origin | Why |
| --- | --- |
| `https://<site>.web.app` | Firebase Hosting live channel |
| `https://<site>.firebaseapp.com` | Firebase Hosting alias |
| `https://production.vector-power.com` | custom domain |
| `http://localhost:3000` / `http://localhost:5000` | local development |
| *(optional)* `https://<site>--<channel>-<hash>.web.app` | this project's preview channels |

### Preview channels

Preview URLs are `https://<siteId>--<channelId>-<hash>.web.app`. Opening CORS to
the whole `*.web.app` domain would be unsafe — anyone can create a Firebase
project and get one. Instead set:

```
CORS_ALLOW_PREVIEW_CHANNELS=true
FIREBASE_SITE_ID=<your globally unique Firebase project id>
```

which appends the regular expression

```
^https://<siteId>--[a-z0-9-]+\.web\.app$
```

Because `<siteId>` is globally unique and must match exactly, no other project's
hostnames can satisfy it. The option is **off by default**.

If `CORS_ALLOW_PREVIEW_CHANNELS` is set but the site id is empty, the app logs a
warning and adds nothing.

Verify a specific origin against a live revision:

```powershell
.\scripts\gcp\verify-green.ps1 -CorsOrigin https://YOUR_GCP_PROJECT_ID.web.app
```

### How to change the list

```powershell
# via the file (commas are safe)
#   edit scripts/gcp/cloudrun.env.yaml  -> CORS_ORIGINS: "https://a,https://b"
gcloud run services update vector-application --region asia-south1 `
  --env-vars-file=scripts\gcp\cloudrun.env.yaml

# ad-hoc from a shell, preserving commas (gcloud escaping: ^<delim>^<value>)
gcloud run services update vector-application --region asia-south1 `
  --update-env-vars="^@^CORS_ORIGINS=https://a,https://b@CORS_ALLOW_PREVIEW_CHANNELS=true"
```

### API hosting options

There is **no** Firebase Hosting rewrite proxying API traffic — the browser
calls Cloud Run directly and sends its origin on every request, which is why a
plain exact-origin list is enough. Do not add a `**` → Cloud Run rewrite without
reading §12 first.

---

## 12. WebSockets

**The `/ws` WebSocket uses the Cloud Run service URL directly — not a custom API
domain and not a Firebase Hosting rewrite.**

`src/components/RealtimeProvider.jsx` resolves the socket in this order:

1. `REACT_APP_WS_BASE_URL`, if set (lets one environment split REST and socket
   hosts);
2. otherwise the host of `REACT_APP_API_BASE_URL`;
3. otherwise the page's own origin — only correct behind the CRA dev server,
   which does **not** proxy `/ws` (see `src/setupProxy.js`).

So in production the browser opens `wss://<cloud-run-host>/ws`.

Why direct and not a Firebase Hosting rewrite:

* Cloud Run supports WebSocket upgrades on its own URL. Firebase Hosting
  rewrites to Cloud Run **do** carry WebSockets, but they add a hop, are
  subject to Hosting's connection/idle limits, and obscure which backend
  revision the socket is attached to — which matters when you are deliberately
  running two revisions.
* A revision-specific URL must not be baked into a bundle either: use the
  **stable service URL** (`gcloud run services describe ... --format='value(status.url)'`)
  or a custom API domain in front of it. Revision URLs are only for
  `verify-green.ps1`.

### Backend requirements (already satisfied)

* `backend/Dockerfile` uses gunicorn with `--threads`, i.e. the **gthread**
  worker, which is what `flask-sock` needs to complete an upgrade.
* `--timeout 0` stops a silent-but-connected socket from being reaped.
* `--workers` defaults to **1** (`WEB_CONCURRENCY` overrides it):
  `backend/realtime.py` broadcasts **in-process**, so the worker that handled
  the write must also hold the sockets. With more than one worker, roughly half
  the notifications are dropped. Raise it only if you first move broadcasts to
  a shared broker.

### Known limitations — read before scaling out

* **Cross-instance broadcasts do not happen.** The server pushes from the
  process that handled the write; with Cloud Run scaled to N instances, a write
  on instance A never reaches sockets held by instance B. This was already true
  before blue/green (2 gunicorn workers × N instances) and is unchanged. It
  makes live updates *eventual* on a busy day, never incorrect.
* **Cloud Run idle timeout** closes a socket that has been silent for the
  platform's limit; the client already reconnects with backoff (3 s → 30 s).
* Every promote/rollback restarts the process, so all sockets reconnect. Pages
  recover on their own; nothing is lost because state lives in Firestore.

---

## 13. Data compatibility rules (Firestore / Storage)

Blue and Green are two revisions of one service talking to **one** Firestore
database, **one** Storage bucket and **one** Firebase Auth tenant, at the same
time. During a release — and after a rollback — both revisions must be able to
read and write the same data.

> **A data migration must remain compatible with both Blue and Green for the
> whole duration of a release.**

### Rules

1. **Expand / contract, never atomic.**
   *Release N (expand):* only add. Write new fields, add new collections, make
   new fields optional, keep old readers working.
   *A later release, after Green is promoted and Blue is retired:* (contract)
   stop writing the old field, then — much later — remove readers.

2. **New fields are always optional.** A document written by Blue must still be
   valid for Green and vice versa. Never make a field required in the same
   release that introduces it; Green will read documents Blue has not yet
   annotated.

3. **Never rename or repurpose a field in place.** Write both old and new for
   one release, then drop the old one in a later release.

4. **Never delete or restructure a collection during a release.** Deletions are
   their own, separately reversible change.

5. **Firestore index changes ship first.** A query that needs a new composite
   index fails on whichever revision runs it. Create the index *before*
   deploying Green, and remove old indexes only after both revisions are gone.
   Index additions are backward compatible; index removals are not.

6. **Treat the read cache as volatile.** The backend keeps an in-process read
   cache (`backend/read_cache.py`) that is per-revision and per-instance. During
   a mixed-traffic window Blue and Green can briefly serve different cached
   snapshots. Writes invalidate it, so this is a staleness window, not a
   correctness bug — but avoid releasing during a data backfill.

7. **Storage object layout is shared.** Never change the object path scheme in
   the same release that changes the code reading it; keep reading old paths for
   at least one release.

8. **JWT secret must be identical.** Both revisions read the same Secret
   Manager version (`jwt-secret:latest`), so sessions survive promote and
   rollback. Never rotate the secret as part of a release.

9. **Backward-compatible only means backward-compatible.** If a release *must*
   break the format, run it as: expand → deploy Green → promote → wait for Blue
   to become idle → contract in the next release. Never combine expand and
   contract in one revision.

10. **Rollback safety.** Anything you promote must be rollback-safe: the old
    revision has to keep working against whatever Green has already written.
    If Green has written new-format documents, Blue must still be able to read
    them — which is exactly rule 1 and 2.

### Quick pre-promote review

- [ ] only additive schema/collection changes?
- [ ] every new field optional and defaulted?
- [ ] new/changed composite indexes already created?
- [ ] old fields still written?
- [ ] no path/URL scheme change that only the new code understands?
- [ ] no dependency on a secret or env var that only the new revision has?

---

## 14. CI

`.github/workflows/pr-checks.yml` runs on every pull request to `main`:

| Job | What it does |
| --- | --- |
| `frontend` | `npm ci`, `npm run build` (with an absolute `REACT_APP_API_BASE_URL`), then asserts the API base URL was actually inlined |
| `backend` | `pip install -r backend/requirements.txt`, `python -m compileall`, `python -m unittest discover` |
| `backend-image` | `docker build ./backend`, asserts no `.env`/`.json` credentials in the image, non-root uid, and a `gunicorn --bind :${PORT}` command |

It has **no** GCP/Firebase credentials (`permissions: contents: read`), no
`gcloud`, no `FIREBASE_SERVICE_ACCOUNT`, and it never deploys. The backend tests
stub `firebase_admin` *before* importing the app, so they cannot read or write
real Firestore/Storage data.

The container is not started with the app in CI because `firestore.client()`
resolves Google ADC at import time and a pull-request runner has none; `/health`
is covered by the unit tests here and by `verify-green.ps1` against a real
revision.

Two other workflows already exist and are untouched:
`firebase-hosting-merge.yml` and `firebase-hosting-pull-request.yml`
— see §15.

---

## 15. Two pre-existing pipelines that bypass blue/green

These are **not** changed by this work (they are the currently working release
path); decide what to do with them before you rely on blue/green.

| Pipeline | Effect on push to `main` | If you want blue/green only |
| --- | --- | --- |
| `cloudbuild.yaml` + its Cloud Build trigger | builds and pushes the image, then runs `gcloud run deploy … --allow-unauthenticated` **without `--no-traffic`** (line 8), so a push to `main` immediately moves 100 % of backend traffic to a new revision — bypassing `deploy-green.ps1` verification and `promote-green.ps1` | delete/disable the trigger in Cloud Build, or point it at a build-only step; deploy with `scripts/gcp/deploy-green.ps1` instead |
| `.github/workflows/firebase-hosting-merge.yml` | deploys the frontend straight to the **live** Hosting channel | change its `channelId` from `live` to a preview channel, or disable the workflow and use `scripts/firebase/deploy-preview.ps1` → `promote-live.ps1` |

Keeping both means every `git push` still redeploys production, which defeats
the point of verification-before-promotion. `scripts/gcp/deploy-green.ps1` does
not delete either file and never disables a trigger for you.

---

## 16. What was changed and why

### Backend

| File | Change | Why |
| --- | --- | --- |
| `backend/Dockerfile` | non-root user; `--workers ${WEB_CONCURRENCY:-1}`; `--threads ${GUNICORN_THREADS:-16}`; `--timeout ${GUNICORN_TIMEOUT:-0}`; port/env knobs; comments | Cloud Run `PORT` and gunicorn preserved; single worker is required by `realtime.py`'s in-process broadcast, threads compensate for held sockets |
| `backend/.dockerignore` | explicit exclusions for `.env*`, `*.json`, `**/*.json`, service-account filename patterns, `tests/`, logs | guarantees no key file or local config can enter the image |
| `backend/.env.example` | new | placeholders for every backend key |
| `backend/__init__.py` | CORS origins de-duplicated/trimmed; optional, project-scoped preview-channel pattern; comment | preview channels work without a `*.web.app` wildcard |
| `backend/tests/**` | new: `fakes.py`, `test_app_smoke.py`, `test_auth_and_realtime.py` | credential-free `/health`, CORS, `/ws`, role-guard and scope tests for CI |

### Frontend / hosting

| File | Change | Why |
| --- | --- | --- |
| `firebase.json` | `index.html` and `/` → `no-cache, no-store, must-revalidate`; `/static/**` → `max-age=31536000, immutable`; `asset-manifest.json`/`manifest.json` → `no-cache`; SPA `**` → `/index.html` kept last | fast, safe rollback: a released or rolled-back shell is fetched immediately, hashed assets stay cached forever |
| `src/components/RealtimeProvider.jsx` | optional `REACT_APP_WS_BASE_URL` override; existing derivation unchanged | environment-specific WebSocket URL without changing current behaviour |
| `.env.example` | new | frontend placeholder template |

### Deployment

| File | Purpose |
| --- | --- |
| `scripts/common.ps1` | shared native/HTTP/confirmation helpers |
| `scripts/gcp/{common,config.example,deploy-green,verify-green,promote-green,rollback,status}.ps1` | Cloud Run blue/green |
| `scripts/gcp/cloudrun.env.yaml.example` | comma-safe Cloud Run env template |
| `scripts/firebase/{common,config.example,deploy-preview,promote-live,rollback-live}.ps1` | Hosting preview → live |
| `.github/workflows/pr-checks.yml` | credential-free PR build/test/image build |
| `docs/gcp-firebase-blue-green.md` | this document |
| `.gitignore`, `backend/.gitignore` | un-ignore `*.env.example` templates; ignore `config.ps1`, `cloudrun.env.yaml`, `.state/` |

### Deliberately **not** changed

* `backend/app.py` and `backend/.env` / `backend/.env.production`.
* `cloudbuild.yaml` and the two existing GitHub workflows (§15).
* Any application route, guard, or Firestore read/write pattern.
* No destructive GCP operation appears in any script: no `revisions delete`, no
  `artifacts docker images delete`, no `hosting:channel:delete`, no Storage or
  Firestore deletion.

---

## 17. Assumptions

1. **Default Hosting site id = Firebase project id.** `scripts/firebase/*.ps1`
   uses `-SiteId` (default: project id). If your Hosting site has a different
   id, set `SiteId` in `scripts/firebase/config.ps1`.
2. **Region `asia-south1`, service `vector-application`, repo `cloud-run-source-deploy`, image
   `vector-api`** are defaults only; every one is a parameter/env/config value.
3. **`--allow-unauthenticated`** stays on (the browser calls Cloud Run directly
   with no IAM token). Pass `-Private` to deploy without it — but then the
   frontend needs another way to authenticate.
4. **Cloud Run's `status.url`** is the stable service URL. Revision URLs
   (`...-<hash>-uc.a.run.app`) are used only by the verification scripts.
5. **Preview channel URL shape** `https://<siteId>--<channelId>-<hash>.web.app`
   (confirmed against Firebase's documented format); the CORS pattern is written
   to accept both `site--channel` and `site--channel-hash`.
6. **`firebase hosting:clone`** is the promotion and rollback primitive because
   firebase-tools v15 has no `hosting:rollback` and no `hosting:releases:list`
   subcommand. Its source argument is `<site>:<channel>` **or** `<site>@<version>`
   — the CLI splits on `:` first, so a version id must use `@`.
7. **PowerShell 5.1 compatibility** — scripts avoid `??`, ternaries and
   `$IsWindows`, and `Invoke-Native` splits stdout from stderr (via PowerShell's
   `2>&1` ErrorRecord distinction) so gcloud warnings can never corrupt a parsed
   `--format` value.

---

## Command card

```powershell
# ---- backend ---------------------------------------------------------------
.\scripts\gcp\deploy-green.ps1                                   # build + push + --no-traffic + verify
.\scripts\gcp\verify-green.ps1 -CorsOrigin https://<site>.web.app # gate on /health + CORS
.\scripts\gcp\promote-green.ps1                                   # 100 % to Green     [promote]
.\scripts\gcp\rollback.ps1                                        # back to Blue       [rollback]
.\scripts\gcp\status.ps1 -ShowImages                              # read-only overview

# ---- frontend --------------------------------------------------------------
.\scripts\firebase\deploy-preview.ps1                            # preview channel only
.\scripts\firebase\promote-live.ps1 -ChannelId <channel>          # to live           [live]
.\scripts\firebase\rollback-live.ps1 -VersionId <VERSION_ID>      # back a version   [rollback]
#   -VersionId builds "<site>@<version>" - @ not :, because hosting:clone
#   treats "<site>:<x>" as a channel. Promote uses "<site>:<channel>".

# ---- observability ---------------------------------------------------------
gcloud run services describe vector-application --region asia-south1
gcloud run revisions list --service vector-application --region asia-south1 --sort-by=~metadata.creationTimestamp
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="vector-application"' --limit 100 --freshness=1h
firebase hosting:channel:list --site <site> --project <project> --json
```
