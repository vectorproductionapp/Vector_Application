#requires -Version 5.1
<#
.SYNOPSIS
    Blue/Green step 5: verify a Green Cloud Run revision before any traffic is
    moved to it.

.DESCRIPTION
    Resolves the target revision (-Revision, else the one recorded by
    deploy-green.ps1), looks up its own revision URL and polls GET <url>/health
    until it answers 200 with {"status":"ok"}.

    Optionally also sends a browser-style CORS preflight from an allowed origin,
    which catches a wrong CORS_ORIGINS before a user does.

    Exits non-zero on failure so it can gate a release pipeline.

.EXAMPLE
    .\scripts\gcp\verify-green.ps1

.EXAMPLE
    .\scripts\gcp\verify-green.ps1 -Revision vector-app-00042-abc

.EXAMPLE
    .\scripts\gcp\verify-green.ps1 -CorsOrigin https://production.vector-power.com
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$Region,
    [string]$Service,
    # Revision to verify. Defaults to the green revision from the state file.
    [string]$Revision = "",
    # Full revision URL; skips the `gcloud run revisions describe` lookup.
    [string]$Url = "",
    [string]$HealthPath = "/health",
    [int]$Retries = 8,
    [int]$RetryDelaySeconds = 5,
    [int]$TimeoutSec = 20,
    # Optional: send an OPTIONS preflight from this Origin and require it back
    # in Access-Control-Allow-Origin.
    [string]$CorsOrigin = ""
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorGcpConfig -BoundParameters $PSBoundParameters

$green = Get-VectorGreenRevision -Config $config -Revision $Revision
if ([string]::IsNullOrWhiteSpace($Url)) {
    if (-not $green) {
        throw "No revision to verify. Pass -Revision, or run deploy-green.ps1 first."
    }
    $Url = Get-VectorRevisionUrl -Config $config -Revision $green
}
if ([string]::IsNullOrWhiteSpace($Url)) { throw "Could not resolve a revision URL." }
$Url = $Url.TrimEnd("/")

Write-VectorBanner "Verifying green revision"
Write-Host ("  revision : {0}" -f $(if ($green) { $green } else { "(taken from -Url)" }))
Write-Host ("  url      : {0}" -f $Url)

$failed = -not (Test-VectorHealthEndpoint -BaseUrl $Url -HealthPath $HealthPath `
            -Retries $Retries -RetryDelaySeconds $RetryDelaySeconds -TimeoutSec $TimeoutSec)

if ((-not $failed) -and (-not [string]::IsNullOrWhiteSpace($CorsOrigin))) {
    $failed = -not (Test-VectorCorsPreflight -BaseUrl $Url -Origin $CorsOrigin -TimeoutSec $TimeoutSec)
}

if ($failed) {
    Write-Host ""
    Write-Host "FAILED - production traffic was not changed." -ForegroundColor Red
    Write-Host "Inspect the revision logs, fix, then re-run deploy-green.ps1." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Green is healthy. It still has 0% of production traffic." -ForegroundColor Green
Write-Host ("  {0}\promote-green.ps1" -f $PSScriptRoot) -ForegroundColor Yellow
exit 0
