# Production deployment runbook

This application is deployed as two services in the **same Google Cloud
project**:

| Component | Platform | Purpose |
| --- | --- | --- |
| React frontend | Firebase Hosting | Serves the browser application |
| Flask backend | Cloud Run | Serves the API, including `/admin/*` routes |
| Data | Cloud Firestore | Stores application data |
| Files | Firebase Storage | Stores uploaded files when used by the application |
| Backend CI/CD | Cloud Build GitHub trigger | Builds and deploys the backend after a push to `main` |

Do not split these components across projects. In this guide, replace
`YOUR_PROJECT_ID` with the one project that owns the frontend, Cloud Run
service, Firestore database, and Storage bucket.

## Architecture

```text
Browser
  -> Firebase Hosting: https://YOUR_PROJECT_ID.web.app
  -> Cloud Run API: https://YOUR_CLOUD_RUN_SERVICE_URL
  -> Firestore and Firebase Storage in YOUR_PROJECT_ID
```

The frontend receives the backend URL at build time through
`REACT_APP_API_BASE_URL`. The browser calls Cloud Run directly, so Cloud Run
must allow unauthenticated invocation and explicitly allow the Hosting origins
through CORS.

## Prerequisites

1. Enable billing on `YOUR_PROJECT_ID`.
2. Add the Google Cloud project to Firebase in the Firebase Console.
3. Install and authenticate the Google Cloud CLI and Firebase CLI:

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
npx firebase-tools login
```

4. Enable these Google Cloud APIs:

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com
```

5. In the Firestore console, create a **Firestore Native** database with the
database ID `(default)`. Do not use a MongoDB-compatible database for this
application; the backend uses the Firebase Admin Firestore client.

## Backend: Cloud Run from GitHub

The backend Dockerfile is at `backend/Dockerfile`. The source repository can
contain the frontend as well: Cloud Build only builds the `backend` directory
when the Dockerfile location below is used.

In Google Cloud Console:

1. Select `YOUR_PROJECT_ID`.
2. Open **Cloud Run** -> **Services** -> **Connect repo**.
3. Choose **Cloud Build** and connect the GitHub repository.
4. Install the Google Cloud Build GitHub app for only this repository.
5. Set the build configuration:

```text
Branch: ^main$
Build type: Dockerfile
Source location: /backend/Dockerfile
```

6. Configure the Cloud Run service:

```text
Service name: vector-app
Container port: 8080
Authentication: Allow unauthenticated invocations
```

Choose a Cloud Run region available to the project. Use the same region as
existing Cloud Run services when the project has reached its region quota.

7. Create the service. Cloud Build creates a trigger. Every later push to
`main` builds `backend/Dockerfile` and deploys a new Cloud Run revision.

### Public API access

The frontend cannot send an identity token to Cloud Run for ordinary API
requests. The service must be public.

In **Cloud Run** -> `vector-app` -> **Security** -> **Manage access**, grant:

```text
Principal: allUsers
Role: Cloud Run Invoker
```

Without this binding, browser requests fail with `403` before Flask receives
them.

### Backend environment variables and secrets

In **Cloud Run** -> `vector-app` -> **Edit & deploy new revision** ->
**Variables & Secrets**, set the following environment variables:

```text
DEBUG=false
CORS_ORIGINS=https://YOUR_PROJECT_ID.web.app,https://YOUR_PROJECT_ID.firebaseapp.com
FIREBASE_STORAGE_BUCKET=YOUR_CONFIRMED_STORAGE_BUCKET
```

`CORS_ORIGINS` is a comma-separated list. Include both Firebase Hosting domains
because either can be used by the browser.

Store sensitive values as Secret Manager secrets, then reference them from the
same Cloud Run screen:

```text
JWT_SECRET=<Secret Manager secret reference>
```

Do not commit `.env`, a Firebase service-account JSON file, or a JWT secret.
Cloud Run uses its runtime service account through Application Default
Credentials; `FIREBASE_CREDENTIALS_PATH` is not required in Cloud Run.

### Cloud Run service account permissions

The Cloud Run runtime service account normally has this form:

```text
PROJECT_NUMBER-compute@developer.gserviceaccount.com
```

Grant it, at minimum:

```text
Cloud Datastore User
Storage Object Admin        # only when the application uploads or deletes files
```

Enable the APIs and create the `(default)` Firestore database before testing
the backend. API-disabled or missing-database errors appear as backend `500`
responses in Cloud Run logs.

### Verify the backend

Open:

```text
https://YOUR_CLOUD_RUN_SERVICE_URL/health
```

Expected response:

```json
{"status":"ok"}
```

## Frontend: Firebase Hosting

Create `.firebaserc` in the repository root (it is intentionally not
committed):

```json
{
  "projects": {
    "default": "YOUR_PROJECT_ID"
  }
}
```

Create `.env.production` in the repository root:

```text
REACT_APP_API_BASE_URL=https://YOUR_CLOUD_RUN_SERVICE_URL
```

`REACT_APP_API_BASE_URL` must be present **before** building. If it is missing,
the React code falls back to relative API paths and Firebase Hosting returns
`index.html` instead of an API response.

Build and release from the repository root, not from `src`:

```powershell
npm ci
npm run build
npx firebase-tools deploy --only hosting --project YOUR_PROJECT_ID
```

Firebase prints the deployed URL, normally:

```text
https://YOUR_PROJECT_ID.web.app
```

`firebase.json` already rewrites unknown frontend routes to `index.html`, which
allows React Router deep links such as `/admin/login`.

## Release sequence

Use this sequence for a new environment:

1. Create the Firestore Native `(default)` database.
2. Deploy the Cloud Run backend from GitHub.
3. Grant `allUsers` the Cloud Run Invoker role.
4. Configure the Cloud Run variables and Secret Manager references.
5. Copy the Cloud Run URL into `.env.production`.
6. Build and deploy Firebase Hosting.
7. Add the two Firebase Hosting URLs to `CORS_ORIGINS` and deploy the Cloud Run
   revision.
8. Test `/health`, the frontend login page, and the first admin registration.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Browser receives Firebase `index.html` for `/admin/register` | The frontend was built without `REACT_APP_API_BASE_URL` | Create `.env.production`, rebuild, and redeploy Hosting |
| `OPTIONS` or `GET` receives `403` with "request was not authenticated" | Cloud Run is private | Grant `allUsers` the Cloud Run Invoker role |
| Browser reports a CORS error | Hosting domain is absent from `CORS_ORIGINS` | Add both `.web.app` and `.firebaseapp.com` origins, then deploy a revision |
| Backend returns `500` and logs say Firestore API is disabled | API not enabled in the backend project | Enable `firestore.googleapis.com` |
| Backend returns `500` and logs say `(default)` database does not exist | Wrong Firestore database type or ID | Create a Firestore Native `(default)` database in the backend project |
| Backend cannot read or write Firestore | Runtime account lacks permissions | Grant Cloud Datastore User to the Cloud Run runtime service account |
| Cloud Run deployment reports a region quota error | The project cannot initialize a new region | Deploy to an already-used region or use a project with available quota |

## Routine releases

### Backend changes

```powershell
git add backend
git commit -m "Describe backend change"
git push origin main
```

The Cloud Build trigger deploys the backend automatically. Monitor
**Cloud Build** -> **History** and Cloud Run revisions.

### Frontend changes

```powershell
npm run build
npx firebase-tools deploy --only hosting --project YOUR_PROJECT_ID
```

The frontend deployment is manual unless a Firebase Hosting GitHub Actions
workflow is added. Keep `REACT_APP_API_BASE_URL` correct before every build.
