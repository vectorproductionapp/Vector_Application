#requires -Version 5.1
<#
.SYNOPSIS
    One-time setup of Workload Identity Federation so GitHub Actions can deploy
    to Google Cloud WITHOUT a long-lived service-account key.

.DESCRIPTION
    Creates:
      * a Workload Identity Pool ("github")
      * an OIDC provider bound to this repository only
      * a least-privilege deployer service account
      * the IAM bindings that tie them together

    Nothing here is destructive and every step is skipped if it already
    exists, so the script is safe to re-run.

    WHY NOT A JSON KEY?
      A service-account key is a permanent credential that lives in GitHub
      forever and, if leaked, grants access to production. This repo is PUBLIC,
      so WIF is strongly preferred: GitHub mints a short-lived token per
    run and GCP checks the caller's identity against the repository itself.

.OUTPUTS
    Prints the two repository *variables* you must set in GitHub. Those values
    are not secret, so they go in Variables, not Secrets.

.EXAMPLE
    .\scripts\gcp\setup-wif.ps1

.EXAMPLE
    .\scripts\gcp\setup-wif.ps1 -ProjectId my-project -Repository me/my-repo
#>
[CmdletBinding()]
param(
    [string]$ProjectId = "vector-production-506505",
    # org/repo that is allowed to deploy. Only this repo can assume the role.
    [string]$Repository = "vectorproductionapp/Vector_Application",
    [string]$Region = "global",
    [string]$PoolId = "github",
    [string]$ProviderId = "github-actions",
    [string]$DeployerSa = "github-actions-deployer",
    # Identity Cloud Run executes as; the deployer must be able to act as it.
    [string]$RuntimeSa = "firebase-adminsdk-fbsvc@vector-production-506505.iam.gserviceaccount.com"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Gcloud {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    # PowerShell 5.1 turns native-command stderr into a terminating
    # NativeCommandError whenever $ErrorActionPreference is 'Stop'.  gcloud
    # writes progress/warnings to stderr even on success, so drop back to
    # 'Continue' for the duration of the call and inspect $LASTEXITCODE
    # ourselves instead.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & gcloud @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($code -ne 0) {
        throw "gcloud $($Arguments -join ' ')`n$($out -join "`n")"
    }
    return ($out | Out-String).Trim()
}

function Test-Gcloud {
    # Returns $false (rather than throwing) when the resource is absent, which
    # is the normal case on a first run.  Same EAP workaround as above.
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & gcloud @Arguments 2>&1
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

$deployerEmail = "$DeployerSa@$ProjectId.iam.gserviceaccount.com"

Write-Host ""
Write-Host "Workload Identity Federation setup" -ForegroundColor Cyan
Write-Host "  project    : $ProjectId"
Write-Host "  repository : $Repository"
Write-Host "  pool       : $PoolId"
Write-Host "  provider   : $ProviderId"
Write-Host "  deployer   : $deployerEmail"
Write-Host "  runtime sa : $RuntimeSa"
Write-Host ""

# --- 0. project number (WIF resource names need it, not the project id) ------
$projectNumber = Invoke-Gcloud "projects" "describe" $ProjectId "--format=value(projectNumber)"
Write-Host "  project number: $projectNumber" -ForegroundColor DarkGray
$poolResource = "projects/$projectNumber/locations/$Region/workloadIdentityPools/$PoolId"

# --- 1. workload identity pool ----------------------------------------------
Write-Host ""
if (Test-Gcloud "iam" "workload-identity-pools" "describe" $PoolId "--location" $Region "--project" $ProjectId) {
    Write-Host "  [skip] pool '$PoolId' already exists" -ForegroundColor DarkGray
} else {
    Invoke-Gcloud "iam" "workload-identity-pools" "create" $PoolId `
        "--location" $Region "--project" $ProjectId `
        "--display-name" "GitHub Actions" | Out-Null
    Write-Host "  [ok]   pool '$PoolId' created" -ForegroundColor Green
}

# --- 2. OIDC provider, locked to this one repository ------------------------
$providerResource = "$poolResource/providers/$ProviderId"
if (Test-Gcloud "iam" "workload-identity-pools" "providers" "describe" $ProviderId `
        "--location" $Region "--workload-identity-pool" $PoolId "--project" $ProjectId) {
    Write-Host "  [skip] provider '$ProviderId' already exists" -ForegroundColor DarkGray
} else {
    # --attribute-condition is what locks this to YOUR repo: a fork, a PR from
    # another repository, or anyone else's workflow cannot assume this role.
    Invoke-Gcloud "iam" "workload-identity-pools" "providers" "create-oidc" $ProviderId `
        "--location" $Region `
        "--workload-identity-pool" $PoolId `
        "--project" $ProjectId `
        "--display-name" "GitHub Actions" `
        "--issuer-uri" "https://token.actions.githubusercontent.com" `
        "--attribute-mapping" "google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" `
        "--attribute-condition" "assertion.repository=='$Repository'" | Out-Null
    Write-Host "  [ok]   provider '$ProviderId' created (restricted to $Repository)" -ForegroundColor Green
}

# --- 3. deployer service account --------------------------------------------
if (Test-Gcloud "iam" "service-accounts" "describe" $deployerEmail "--project" $ProjectId) {
    Write-Host "  [skip] deployer SA already exists" -ForegroundColor DarkGray
} else {
    Invoke-Gcloud "iam" "service-accounts" "create" $DeployerSa `
        "--project" $ProjectId `
        "--display-name" "GitHub Actions blue-green deployer" | Out-Null
    Write-Host "  [ok]   deployer SA created" -ForegroundColor Green
}

# --- 4. least-privilege roles ------------------------------------------------
# run.admin        : create revisions and move traffic
# artifactregistry : build + push images
# secretAccessor   : read JWT_SECRET etc. when describing revisions
# serviceAccountUser(only on the runtime SA) : let Cloud Run run as that identity
$roles = @(
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/secretmanager.secretAccessor"
)
foreach ($role in $roles) {
    Invoke-Gcloud "projects" "add-iam-policy-binding" $ProjectId `
        "--member" "serviceAccount:$deployerEmail" `
        "--role" $role "--condition=None" "--quiet" | Out-Null
    Write-Host "  [ok]   $role" -ForegroundColor Green
}

Invoke-Gcloud "iam" "service-accounts" "add-iam-policy-binding" $RuntimeSa `
    "--project" $ProjectId `
    "--role" "roles/iam.serviceAccountUser" `
    "--member" "serviceAccount:$deployerEmail" "--quiet" | Out-Null
Write-Host "  [ok]   roles/iam.serviceAccountUser on $RuntimeSa" -ForegroundColor Green

# --- 5. let this repository assume the deployer SA ---------------------------
$principalSet = "principalSet://iam.googleapis.com/$poolResource/attribute.repository/$Repository"
Invoke-Gcloud "iam" "service-accounts" "add-iam-policy-binding" $deployerEmail `
    "--project" $ProjectId `
    "--role" "roles/iam.workloadIdentityUser" `
    "--member" $principalSet "--quiet" | Out-Null
Write-Host "  [ok]   roles/iam.workloadIdentityUser for $Repository" -ForegroundColor Green

# --- 6. what to paste into GitHub --------------------------------------------
Write-Host ""
Write-Host "SETUP COMPLETE" -ForegroundColor Cyan
Write-Host ""
Write-Host "Now set these two repository VARIABLES in GitHub" -ForegroundColor Yellow
Write-Host "(Settings -> Secrets and variables -> Actions -> Variables tab):" -ForegroundColor Yellow
Write-Host ""
Write-Host "  WIF_PROVIDER = $providerResource" -ForegroundColor White
Write-Host "  DEPLOYER_SA  = $deployerEmail" -ForegroundColor White
Write-Host ""
Write-Host "Verify the assumption works end-to-end:" -ForegroundColor DarkGray
Write-Host "  gcloud iam workload-identity-pools describe $PoolId --location $Region --project $ProjectId" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Re-running this script is safe - every step above is idempotent." -ForegroundColor DarkGray
