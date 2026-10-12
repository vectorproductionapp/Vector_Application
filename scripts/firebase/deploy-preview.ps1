#requires -Version 5.1
<#
.SYNOPSIS
    Frontend green release: build the React app and deploy it to a Firebase
    Hosting PREVIEW channel. The live channel is never touched.

.DESCRIPTION
    1. `npm ci` + `npm run build` with REACT_APP_API_BASE_URL (and optionally
       REACT_APP_WS_BASE_URL) inlined for this environment.
    2. `firebase hosting:channel:deploy <channel>` - creates/updates a preview
       channel, which gets its own https://<site>--<channel>-<hash>.web.app URL.
    3. Prints that URL.
    4. Verifies the backend /health endpoint the bundle points at, plus the
       preview URL itself.

    Preview channels share the production Firebase project, so they read and
    write REAL Firestore data - that is intentional for validation, and is why
    this script never promotes anything on its own.

.EXAMPLE
    .\scripts\firebase\deploy-preview.ps1

.EXAMPLE
    .\scripts\firebase\deploy-preview.ps1 -ChannelId green-20261010 -ApiBaseUrl https://vector-application-531004235498.asia-south1.run.app
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$SiteId,
    # Preview channel id (hostname-safe: lowercase letters, digits, hyphens).
    [string]$ChannelId,
    # Backend URL baked into this bundle. Defaults to the configured stable
    # API URL; point it at the Green revision URL to test both halves at once.
    [string]$ApiBaseUrl,
    [string]$WsBaseUrl,
    # Preview channel lifetime, e.g. 7d / 12h / 30d.
    [string]$Expires = "",
    # Backend /health to check before reporting success.
    [string]$HealthUrl = "",
    [switch]$SkipBuild,
    [switch]$SkipInstall,
    [switch]$SkipVerify
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorFirebaseConfig -BoundParameters $PSBoundParameters
if (-not [string]::IsNullOrWhiteSpace($Expires)) { $config.ChannelTtl = $Expires }

if ([string]::IsNullOrWhiteSpace($ChannelId)) {
    $ChannelId = "green-" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
}
if ($ChannelId -cnotmatch '^[a-z0-9-]+$') {
    throw "ChannelId '$ChannelId' must match ^[a-z0-9-]+`$ (lowercase letters, digits, hyphens - it becomes part of the preview hostname)."
}
if ($config.ChannelTtl -cnotmatch '^\d+[dhm]$') {
    throw "Expires/ChannelTtl '$($config.ChannelTtl)' must look like 7d, 12h or 30d."
}

# channel:channel:deploy cannot take --site, so make sure the site the CLI will
# pick is the same one promote-live.ps1 / rollback-live.ps1 will read from.
$hostingSite = Get-VectorHostingSite -Config $config
if ($hostingSite -cne [string]$config.SiteId) {
    throw ("Hosting site mismatch.`n" +
           "  firebase hosting:channel:deploy will target : $hostingSite`n" +
           "  promote-live.ps1 / rollback-live.ps1 use --site : $($config.SiteId)`n" +
           "Set SiteId to '$hostingSite' in scripts/firebase/config.ps1 (or in .env/config), " +
           "or add a matching `"site`": `"$hostingSite`" entry under `"hosting`" in firebase.json.")
}

Write-VectorBanner "Green frontend -> preview channel"
Write-Host ("  project : {0}" -f $config.ProjectId)
Write-Host ("  site    : {0}" -f $hostingSite)
Write-Host ("  channel : {0}" -f $ChannelId)
Write-Host ("  expires : {0}" -f $config.ChannelTtl)
Write-Host ("  api     : {0}" -f $(if ($config.ApiBaseUrl) { $config.ApiBaseUrl } else { "<not set>" }))
Write-Host ("  live    : untouched") -ForegroundColor Green

# --- 1. build ----------------------------------------------------------------
if ($SkipBuild) {
    Write-Host "  Skipping build (-SkipBuild); using the existing build\ directory." -ForegroundColor Yellow
    if (-not (Test-Path -LiteralPath (Join-Path (Get-VectorRepoRoot) "build\index.html"))) {
        throw "build\index.html not found at $(Join-Path (Get-VectorRepoRoot) 'build') - run without -SkipBuild."
    }
    if ([string]::IsNullOrWhiteSpace([string]$config.ApiBaseUrl)) {
        Write-Host "  WARNING: -SkipBuild reuses a bundle whose REACT_APP_API_BASE_URL cannot be re-checked." -ForegroundColor Yellow
        Write-Host "           Re-run without -SkipBuild if you are unsure which backend that bundle calls." -ForegroundColor Yellow
    }
} else {
    Invoke-FrontendBuild -Config $config -SkipInstall:$SkipInstall
}

# --- 2 + 3. deploy to the preview channel and print its URL ------------------
Write-VectorBanner "Deploying preview channel"
$deploy = Invoke-Firebase -Arguments @(
    "hosting:channel:deploy", $ChannelId,
    "--project", $config.ProjectId,
    "--expires", $config.ChannelTtl,
    "--non-interactive"
)
Write-Host $deploy.Text

$previewUrl = Get-ChannelUrl -Config $config -ChannelId $ChannelId -DeployOutput $deploy.Text
if (-not $previewUrl) {
    $open = Invoke-Firebase -Arguments @(
        "hosting:channel:open", $ChannelId, "--project", $config.ProjectId, "--non-interactive"
    ) -AllowFailure
    $previewUrl = Get-PreviewUrlFromText -Text $open.Text
}

Write-VectorBanner "Preview URL"
if ($previewUrl) {
    Write-Host ("  {0}" -f $previewUrl) -ForegroundColor Green
    Write-Host ("  (channel '{0}', expires {1})" -f $ChannelId, $config.ChannelTtl) -ForegroundColor DarkGray

    # Remember what was just previewed so promote-live.ps1 can find it without
    # the channel id having to be typed twice.
    $stateDir = Join-Path $script:VectorFirebaseRoot ".state"
    if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
    @{
        ChannelId    = $ChannelId
        PreviewUrl   = $previewUrl
        ProjectId    = $config.ProjectId
        SiteId       = $config.SiteId
        ApiBaseUrl   = $config.ApiBaseUrl
        WsBaseUrl    = $config.WsBaseUrl
        DeployedAt   = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir "preview.json") -Encoding UTF8
} else {
    Write-Host "  Could not read the channel URL automatically." -ForegroundColor Yellow
    Write-Host ("  Run: firebase hosting:channel:open {0} --project {1}" -f $ChannelId, $config.ProjectId) -ForegroundColor Yellow
}

# --- 4. verify ---------------------------------------------------------------
if ($SkipVerify) {
    Write-Host "  Skipping verification (-SkipVerify)." -ForegroundColor Yellow
} else {
    # The backend this bundle will call.
    $healthBase = ""
    if (-not [string]::IsNullOrWhiteSpace($HealthUrl)) {
        $healthBase = $HealthUrl.TrimEnd("/")
        if ($healthBase.EndsWith("/health")) { $healthBase = $healthBase.Substring(0, $healthBase.Length - "/health".Length) }
    } elseif (-not [string]::IsNullOrWhiteSpace($config.ApiBaseUrl)) {
        $healthBase = $config.ApiBaseUrl.TrimEnd("/")
    }

    if ($healthBase) {
        Write-VectorBanner "Backend this bundle talks to"
        if (Test-VectorHealthEndpoint -BaseUrl $healthBase) {
            Write-Host ("  API base URL : {0}" -f $config.ApiBaseUrl) -ForegroundColor Green
        } else {
            Write-Host "  Backend /health did not answer - the preview will not work." -ForegroundColor Red
            exit 1
        }
    }
    if ($previewUrl) {
        $page = Get-VectorHttpResponse -Uri $previewUrl -TimeoutSec 20
        if ($page.Ok -and $page.Status -eq 200) {
            Write-Host ("  PASS: GET {0} -> 200" -f $previewUrl) -ForegroundColor Green
        } else {
            Write-Host ("  FAILED: GET {0} -> HTTP {1} ({2})" -f $previewUrl, $page.Status, $page.Error) -ForegroundColor Red
            exit 1
        }
    }
}

Write-VectorBanner "Preview checklist"
Write-Host "  [ ] sign in works (proves the API URL was baked into the bundle)"
Write-Host "  [ ] a list page loads and the live-update dot in the header turns green (/ws)"
Write-Host "  [ ] a save succeeds and another open tab refreshes"
Write-Host "  [ ] attachments / images load"
Write-Host "  [ ] browser console has no CORS or 404-in-index.html errors"
Write-Host ""
Write-Host "Preview is NOT live. To promote it:" -ForegroundColor Yellow
Write-Host ("  {0}\promote-live.ps1 -ChannelId {1}" -f $PSScriptRoot, $ChannelId) -ForegroundColor Yellow
