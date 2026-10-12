#requires -Version 5.1
<#
.SYNOPSIS
    Send 100% of production traffic back to the previously live (Blue) revision
    - no rebuild, no image pull, no deletion.

.DESCRIPTION
    The target revision is, in order:
      1. -Revision, if you pass it
      2. the RollbackTarget recorded by the last promote-green.ps1 / rollback.ps1
      3. the Blue revision recorded by the last deploy-green.ps1

    If none is known the script refuses to guess and tells you how to find one
    with status.ps1. Cloud Run revisions and Artifact Registry images are never
    deleted, so the target is still there even if the state file is gone.

.EXAMPLE
    .\scripts\gcp\rollback.ps1

.EXAMPLE
    .\scripts\gcp\rollback.ps1 -Revision vector-app-00041-abc -Yes
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$Region,
    [string]$Service,
    [string]$Repository,
    [string]$Image,
    # Revision to send traffic back to. Defaults to the recorded rollback target.
    [string]$Revision = "",
    [ValidateRange(1, 100)]
    [int]$Percent = 100,
    # The rollback target is a revision that was healthy a moment ago, but the
    # check still costs a few seconds - pass -SkipVerify in a genuine emergency.
    [switch]$SkipVerify,
    [switch]$Yes
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorGcpConfig -BoundParameters $PSBoundParameters

$state = Read-VectorState -Service $config.Service
$target = $Revision
if ([string]::IsNullOrWhiteSpace($target)) { $target = Get-VectorStateValue -State $state -Name "RollbackTarget" }
if ([string]::IsNullOrWhiteSpace([string]$target)) { $target = Get-VectorStateValue -State $state -Name "Blue" }

# Refuse before touching the network: a missing state file is not a reason to
# talk to gcloud, and this script must never invent a revision on your behalf.
if ([string]::IsNullOrWhiteSpace([string]$target)) {
    Write-VectorBanner "Rollback"
    Write-Host ("  service : {0}" -f $config.Service)
    Write-Host ""
    Write-Host "No rollback target is known, and this script will not guess." -ForegroundColor Red
    Write-Host "Pick a revision explicitly and re-run:" -ForegroundColor Red
    Write-Host ("  {0}\status.ps1           # list revisions and current traffic" -f $PSScriptRoot) -ForegroundColor Yellow
    Write-Host ("  {0}\rollback.ps1 -Revision <REVISION>" -f $PSScriptRoot) -ForegroundColor Yellow
    exit 1
}

$live = Get-VectorLiveRevision -Config $config

Write-VectorBanner "Rollback"
Write-Host ("  service : {0}" -f $config.Service)
Write-Host ("  live    : {0} ({1}%)" -f $(if ($live.Revision) { $live.Revision } else { "<unknown>" }), $live.Percent)
Write-Host ("  target  : {0}" -f $target) -ForegroundColor Yellow

if ($live.Revision -eq $target) {
    Write-Host ""
    Write-Host ("Production is already serving {0}. Nothing to do." -f $target) -ForegroundColor Yellow
    exit 0
}

$targetUrl = Get-VectorRevisionUrl -Config $config -Revision $target
if (-not $SkipVerify) {
    if (-not (Test-VectorHealthEndpoint -BaseUrl $targetUrl)) {
        Write-Host ""
        Write-Host "Rollback target did not pass /health." -ForegroundColor Red
        Write-Host "Re-run with -SkipVerify if you are certain it is serving." -ForegroundColor Red
        exit 1
    }
}

Confirm-VectorAction -Phrase "rollback" -Yes:$Yes -Description (
    "About to send {0}% of PRODUCTION traffic for service '{1}' back to revision {2}." -f $Percent, $config.Service, $target
)

Invoke-Gcloud -Arguments @(
    "run", "services", "update-traffic", $config.Service,
    "--to-revisions", ("{0}={1}" -f $target, $Percent),
    "--region", $config.Region,
    "--project", $config.ProjectId,
    "--quiet"
) | Out-Null

# Swap the pair so a second rollback returns to where we just came from.
$statePath = Merge-VectorState -Service $config.Service -Values @{
    LiveRevision   = $target
    RollbackTarget = $live.Revision
    RolledBackAt   = (Get-Date).ToUniversalTime().ToString("o")
}
$serviceUrl = (Get-VectorLiveRevision -Config $config).Url

Write-VectorBanner "Rolled back"
Write-Host ("  production : {0}" -f $serviceUrl) -ForegroundColor Green
Write-Host ("  revision   : {0} ({1}%)" -f $target, $Percent) -ForegroundColor Green
Write-Host ("  previous   : {0}" -f $(if ($live.Revision) { $live.Revision } else { "<unknown>" })) -ForegroundColor DarkGray
Write-Host ("  state      : {0}" -f $statePath) -ForegroundColor DarkGray
Write-Host ""
Write-Host "No image was rebuilt and no revision was deleted." -ForegroundColor Green
