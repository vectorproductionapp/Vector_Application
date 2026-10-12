#requires -Version 5.1
<#
.SYNOPSIS
    Blue/Green step 1-5: build, push, deploy to Cloud Run with NO traffic, then
    verify the new ("Green") revision through its own revision URL.

.DESCRIPTION
    Produces a uniquely tagged container image, pushes it to Artifact Registry
    and creates a new Cloud Run revision with --no-traffic.  Production traffic
    stays on the existing ("Blue") revision the whole time; the only thing that
    moves production is promote-green.ps1.

    Nothing is deleted: revisions, images, and the local state file are all
    kept so rollback stays possible.

.EXAMPLE
    .\scripts\gcp\deploy-green.ps1 -ProjectId my-project -Tag green-20261010-1

.EXAMPLE
    .\scripts\gcp\deploy-green.ps1 -Builder cloudbuild -SkipVerify
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$Region,
    [string]$Service,
    [string]$Repository,
    [string]$Image,
    [string]$Tag,
    [ValidateSet("docker", "cloudbuild", "")]
    [string]$Builder = "",
    [string]$Source = "",

    # Reuse an image tag that was already built instead of building again.
    [switch]$SkipBuild,
    # Do not call verify-green.ps1 after the revision exists.
    [switch]$SkipVerify,
    # Do not grant allUsers the Cloud Run Invoker role on this revision.
    [switch]$Private,
    # Apply a /health startup probe to the new revision.
    [switch]$StartupProbe,

    # KEY=VALUE pairs passed to --update-env-vars (plain, non-secret values
    # only; use -Secret for anything sensitive). Values must not contain commas.
    [string[]]$EnvVar = @(),
    # Path to a gcloud env-vars file (YAML or KEY=VALUE lines) passed to
    # --env-vars-file. Commas are safe here, so this is the way to set
    # CORS_ORIGINS. NOTE: --env-vars-file REPLACES every environment variable on
    # the service, so it belongs in a first deployment or a deliberate full
    # reconfiguration - not in an ordinary release.
    [string]$EnvVarsFile = "",
    # KEY=SECRET_ID:VERSION pairs passed to --update-secrets, e.g.
    #   -Secret "JWT_SECRET=my-jwt-secret:latest"
    [string[]]$Secret = @()
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorGcpConfig -BoundParameters $PSBoundParameters
if (-not [string]::IsNullOrWhiteSpace($Builder)) { $config.Builder = $Builder }
if (-not [string]::IsNullOrWhiteSpace($Source)) { $config.Source = $Source }

# --- 1. uniquely tagged image ------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Tag)) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
    $sha = ""
    if (Test-Tool "git") {
        $gitResult = Invoke-Native -File "git" -Arguments @(
            "-C", (Get-VectorRepoRoot), "rev-parse", "--short=8", "HEAD"
        ) -AllowFailure
        if ($gitResult.ExitCode -eq 0) { $sha = $gitResult.Output.Trim() }
    }
    $Tag = if ($sha) { "green-$stamp-$sha" } else { "green-$stamp" }
}

$fullImage = "{0}/{1}/{2}/{3}:{4}" -f $config.RegistryHost, $config.ProjectId, $config.Repository, $config.Image, $Tag

Write-VectorBanner "Green backend deploy"
Write-Host ("  project    : {0}" -f $config.ProjectId)
Write-Host ("  region     : {0}" -f $config.Region)
Write-Host ("  service    : {0}" -f $config.Service)
Write-Host ("  image      : {0}" -f $fullImage)
Write-Host ("  builder    : {0}" -f $config.Builder)
Write-Host ("  source     : {0}" -f $config.Source)
Write-Host ("  production : unchanged (deploying with --no-traffic)") -ForegroundColor Green

# Fail on a bad source path before talking to the network.
if (-not (Test-Path -LiteralPath $config.Source)) {
    throw "Source directory not found: $($config.Source)"
}
if (-not (Test-Path -LiteralPath (Join-Path $config.Source "Dockerfile"))) {
    throw "No Dockerfile in $($config.Source)"
}

# Who is live right now?  This is the Blue revision and it must not move.
$liveBefore = Get-VectorLiveRevision -Config $config
if ($liveBefore.Revision) {
    Write-Host ("  blue       : {0} ({1}% traffic)" -f $liveBefore.Revision, $liveBefore.Percent)
} else {
    Write-Host "  blue       : none yet - this looks like the first deployment." -ForegroundColor Yellow
}

# --- 2. build + push ---------------------------------------------------------
if ($SkipBuild) {
    Write-Host "  Skipping build (-SkipBuild); assuming $fullImage already exists." -ForegroundColor Yellow
} elseif ($config.Builder -eq "cloudbuild") {
    Write-VectorBanner "Building image with Cloud Build"
    Invoke-Gcloud -Arguments @(
        "builds", "submit", $config.Source,
        "--tag", $fullImage,
        "--project", $config.ProjectId,
        "--quiet"
    ) | Out-Null
} else {
    Write-VectorBanner "Building image with Docker"
    if (-not (Test-Tool "docker")) {
        throw "docker was not found on PATH. Install Docker, or pass -Builder cloudbuild."
    }
    Invoke-Gcloud -Arguments @(
        "auth", "configure-docker", $config.RegistryHost, "--quiet"
    ) | Out-Null
    Invoke-Native -File "docker" -Arguments @("build", "-t", $fullImage, $config.Source) | Out-Null
    Invoke-Native -File "docker" -Arguments @("push", $fullImage) | Out-Null
}

# --- 3. deploy as a new revision with --no-traffic ---------------------------
Write-VectorBanner "Deploying new revision (no traffic)"
$deployArgs = @(
    "run", "deploy", $config.Service,
    "--image", $fullImage,
    "--region", $config.Region,
    "--project", $config.ProjectId,
    "--platform", "managed",
    "--port", "8080",
    "--no-traffic",
    "--quiet"
)
if (-not $Private) { $deployArgs += "--allow-unauthenticated" }
if (-not [string]::IsNullOrWhiteSpace($EnvVarsFile)) {
    $resolvedEnvFile = $EnvVarsFile
    if (-not [System.IO.Path]::IsPathRooted($resolvedEnvFile)) {
        $resolvedEnvFile = Join-Path (Get-VectorRepoRoot) $EnvVarsFile
    }
    if (-not (Test-Path -LiteralPath $resolvedEnvFile)) {
        throw "Env-vars file not found: $resolvedEnvFile (copy scripts/gcp/cloudrun.env.yaml.example)"
    }
    # REPLACES every environment variable on the service - intentional for a
    # first deployment; use -EnvVar for an ordinary release.
    $deployArgs += @("--env-vars-file", $resolvedEnvFile)
} elseif ($EnvVar.Count -gt 0) {
    # Plain environment variables. Values must not contain commas.
    $deployArgs += @("--update-env-vars", ($EnvVar -join ","))
}
if ($Secret.Count -gt 0) {
    # Secret Manager references - the only place a secret should come from.
    $deployArgs += @("--update-secrets", ($Secret -join ","))
}
if ($StartupProbe) {
    $deployArgs += "--startup-probe=httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=5,failureThreshold=12,timeoutSeconds=3"
}
Invoke-Gcloud -Arguments $deployArgs | Out-Null

# --- 4. identify and print the Green revision --------------------------------
$describe = Invoke-Gcloud -Arguments @(
    "run", "services", "describe", $config.Service,
    "--region", $config.Region,
    "--project", $config.ProjectId,
    "--format=value(status.latestCreatedRevisionName)"
)
$green = ($describe.Output -replace "`r`n", "" -replace "`n", "").Trim()
if ([string]::IsNullOrWhiteSpace($green)) {
    throw "Could not determine the revision that was just created."
}
$greenUrl = Get-VectorRevisionUrl -Config $config -Revision $green

Write-VectorBanner "Green revision"
Write-Host ("  name : {0}" -f $green) -ForegroundColor Green
Write-Host ("  url  : {0}" -f $greenUrl) -ForegroundColor Green
Write-Host ("  health: {0}/health" -f $greenUrl) -ForegroundColor Green

$statePath = Merge-VectorState -Service $config.Service -Values @{
    ProjectId         = $config.ProjectId
    Region            = $config.Region
    RegistryHost      = $config.RegistryHost
    Repository        = $config.Repository
    Image             = $fullImage
    Tag               = $Tag
    Blue              = $liveBefore.Revision
    BlueUrl           = $liveBefore.Url
    PendingGreen      = $green
    GreenUrl          = $greenUrl
    GreenDeployedAt   = (Get-Date).ToUniversalTime().ToString("o")
}
Write-Host ("  state: {0}" -f $statePath) -ForegroundColor DarkGray

# --- 5. verify Green (production traffic is still on Blue) -------------------
if ($SkipVerify) {
    Write-Host "  Skipping health verification (-SkipVerify)." -ForegroundColor Yellow
} elseif (Test-VectorHealthEndpoint -BaseUrl $greenUrl) {
    Write-Host ""
    Write-Host "Production traffic has NOT moved. Review the result, then run:" -ForegroundColor Yellow
    Write-Host ("  {0}\promote-green.ps1" -f $PSScriptRoot) -ForegroundColor Yellow
    exit 0
} else {
    Write-Host ""
    Write-Host "Green verification FAILED. Production traffic was not changed." -ForegroundColor Red
    Write-Host "Inspect the revision, then re-run this script with a fresh tag." -ForegroundColor Red
    Write-Host ("  {0}\status.ps1" -f $PSScriptRoot) -ForegroundColor Red
    exit 1
}
