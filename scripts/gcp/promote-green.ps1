#requires -Version 5.1
<#
.SYNOPSIS
    Blue/Green step 7: send 100% of production traffic to the verified Green
    revision, keeping the previous (Blue) revision for immediate rollback.

.DESCRIPTION
    Nothing is rebuilt and nothing is deleted. The only command that moves
    production traffic is this one, and it refuses to run until you type
    "promote" (or pass -Yes from a pipeline).

    The revision that was live beforehand is written to the local state file as
    the rollback target.

.EXAMPLE
    .\scripts\gcp\promote-green.ps1

.EXAMPLE
    .\scripts\gcp\promote-green.ps1 -Revision vector-app-00043-def -Yes
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$Region,
    [string]$Service,
    [string]$Repository,
    [string]$Image,
    # Revision to promote. Defaults to the green revision from the state file.
    [string]$Revision = "",
    # Share of traffic to hand over. 100 unless you deliberately want a canary.
    [ValidateRange(1, 100)]
    [int]$Percent = 100,
    # Re-run /health against Green before moving any traffic.
    [switch]$SkipVerify,
    # Also send a CORS preflight from this origin before moving traffic.
    [string]$CorsOrigin = "",
    # Skip the interactive confirmation (use from an approved pipeline only).
    [switch]$Yes
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorGcpConfig -BoundParameters $PSBoundParameters

$green = Get-VectorGreenRevision -Config $config -Revision $Revision
if (-not $green) {
    throw "No green revision found. Run deploy-green.ps1 first, or pass -Revision."
}
$greenUrl = Get-VectorRevisionUrl -Config $config -Revision $green

Write-VectorBanner "Promoting green revision"
Write-Host ("  green : {0}" -f $green) -ForegroundColor Green
Write-Host ("  url   : {0}" -f $greenUrl)

$live = Get-VectorLiveRevision -Config $config
$blue = $live.Revision
if ($blue -eq $green) {
    Write-Host ""
    Write-Host ("Production is already serving {0} at {1}%. Nothing to do." -f $green, $live.Percent) -ForegroundColor Yellow
    exit 0
}
if ($blue) {
    Write-Host ("  blue  : {0}  <- this becomes the rollback target" -f $blue) -ForegroundColor DarkGray
} else {
    Write-Host "  blue  : none (first promotion)" -ForegroundColor DarkGray
}

# --- verify before touching traffic -----------------------------------------
if (-not $SkipVerify) {
    if (-not (Test-VectorHealthEndpoint -BaseUrl $greenUrl)) {
        Write-Host ""
        Write-Host "Refusing to promote: Green did not pass /health." -ForegroundColor Red
        exit 1
    }
    if (-not [string]::IsNullOrWhiteSpace($CorsOrigin)) {
        if (-not (Test-VectorCorsPreflight -BaseUrl $greenUrl -Origin $CorsOrigin)) {
            Write-Host ""
            Write-Host "Refusing to promote: CORS preflight failed." -ForegroundColor Red
            exit 1
        }
    }
} else {
    Write-Host "  Skipping verification (-SkipVerify)." -ForegroundColor Yellow
}

Confirm-VectorAction -Phrase "promote" -Yes:$Yes -Description (
    "About to send {0}% of PRODUCTION traffic for service '{1}' to revision {2}.`n" -f $Percent, $config.Service, $green
)

# --- move traffic -------------------------------------------------------------
Write-VectorBanner "Updating traffic"
Invoke-Gcloud -Arguments @(
    "run", "services", "update-traffic", $config.Service,
    "--to-revisions", ("{0}={1}" -f $green, $Percent),
    "--region", $config.Region,
    "--project", $config.ProjectId,
    "--quiet"
) | Out-Null

$statePath = Merge-VectorState -Service $config.Service -Values @{
    LiveRevision  = $green
    RollbackTarget = $blue
    PromotedAt    = (Get-Date).ToUniversalTime().ToString("o")
}
$serviceUrl = (Get-VectorLiveRevision -Config $config).Url

Write-VectorBanner "Promoted"
Write-Host ("  production : {0}" -f $serviceUrl) -ForegroundColor Green
Write-Host ("  revision   : {0} ({1}%)" -f $green, $Percent) -ForegroundColor Green
Write-Host ("  rollback to: {0}" -f $(if ($blue) { $blue } else { "<none>" })) -ForegroundColor DarkGray
Write-Host ("  state      : {0}" -f $statePath) -ForegroundColor DarkGray
Write-Host ""
Write-Host "If something is wrong:" -ForegroundColor Yellow
Write-Host ("  {0}\rollback.ps1" -f $PSScriptRoot) -ForegroundColor Yellow
