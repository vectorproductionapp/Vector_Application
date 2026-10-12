#requires -Version 5.1
<#
.SYNOPSIS
    Frontend promotion: move a tested preview channel to the LIVE channel.

.DESCRIPTION
    Uses `firebase hosting:clone <site>:<channel> <site>:live`, which copies the
    exact Hosting version that was deployed to the preview channel. No rebuild,
    no re-upload - the bytes you validated are the bytes that go live.

    This is the ONLY script that publishes the frontend, and it always asks you
    to type "live" first (or pass -Yes from an approved, manual pipeline step).
    Nothing in .github/workflows calls it.

    Preview channels and live share the same Firebase project, so both talk to
    the same production Firestore, Storage and Cloud Run service.

.EXAMPLE
    .\scripts\firebase\promote-live.ps1 -ChannelId green-20261010-153000

.EXAMPLE
    .\scripts\firebase\promote-live.ps1 -ChannelId green-20261010-153000 -Yes
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$SiteId,
    # Preview channel to promote. Required unless a state file records the last
    # one, which deploy-preview.ps1 writes.
    [string]$ChannelId,
    # Skip the interactive confirmation (approved pipeline only).
    [switch]$Yes
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorFirebaseConfig -BoundParameters $PSBoundParameters

$stateFile = Join-Path $script:VectorFirebaseRoot ".state\preview.json"
if ([string]::IsNullOrWhiteSpace($ChannelId) -and (Test-Path -LiteralPath $stateFile)) {
    try {
        $recorded = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if ($recorded.ChannelId) { $ChannelId = [string]$recorded.ChannelId }
    } catch {
        # Ignore an unreadable state file; ask below.
    }
}
if ([string]::IsNullOrWhiteSpace($ChannelId)) {
    throw ("No preview channel given.`n" +
           "  Pass -ChannelId <channel> (see: firebase hosting:channel:list --project " + $config.ProjectId + ")")
}
if ($ChannelId -eq "live") {
    throw "The 'live' channel cannot be promoted to itself. Give a preview channel id."
}

Write-VectorBanner "Promote preview -> live"
Write-Host ("  project : {0}" -f $config.ProjectId)
Write-Host ("  site    : {0}" -f $config.SiteId)
Write-Host ("  source  : {0}:{1}" -f $config.SiteId, $ChannelId)
Write-Host ("  target  : {0}:live" -f $config.SiteId)
Write-Host ""
Write-Host "This publishes the frontend. It does not touch Cloud Run, Firestore," -ForegroundColor Yellow
Write-Host "Storage or Firebase Auth, and it does not delete the preview." -ForegroundColor Yellow

Confirm-VectorAction -Phrase "live" -Yes:$Yes -Description (
    "About to make the contents of preview channel '" + $ChannelId + "' the LIVE site for '" + $config.SiteId + "'."
)

# --- what is live right now? That becomes the rollback target ---------------
# Best effort: every call here is allowed to fail, because a promotion that
# already succeeded must not be reported as a failure over reporting.
$previousLiveVersion = ""
try {
    $previousLiveVersion = Get-HostingChannelVersion -Channel (Get-HostingChannelFromSite -Config $config -ChannelId "live")
} catch { }

# --- promote: clone the exact hosting version --------------------------------
$clone = Invoke-Firebase -Arguments @(
    "hosting:clone",
    ($config.SiteId + ":" + $ChannelId),
    ($config.SiteId + ":live"),
    "--project", $config.ProjectId,
    "--non-interactive"
)
Write-Host $clone.Text

# --- what to record for the next rollback -------------------------------------
Write-VectorBanner "Live channel updated"
$liveUrl = "https://{0}.web.app" -f $config.SiteId
Write-Host ("  url      : {0}" -f $liveUrl) -ForegroundColor Green
Write-Host ("  also     : https://{0}.firebaseapp.com" -f $config.SiteId) -ForegroundColor DarkGray

$currentLiveVersion = ""
try {
    $currentLiveVersion = Get-HostingChannelVersion -Channel (Get-HostingChannelFromSite -Config $config -ChannelId "live")
} catch { }

if ($currentLiveVersion) {
    Write-Host ("  version  : {0}" -f $currentLiveVersion) -ForegroundColor Yellow
} else {
    Write-Host "  version  : <could not read it - use the console below>" -ForegroundColor Yellow
}
if ($previousLiveVersion -and ($previousLiveVersion -cne $currentLiveVersion)) {
    Write-Host ("  previous : {0}  <- rollback target" -f $previousLiveVersion) -ForegroundColor DarkGray
}

if ($currentLiveVersion -or $previousLiveVersion) {
    $stateDir = Join-Path $script:VectorFirebaseRoot ".state"
    if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
    @{
        CurrentLiveVersion  = $currentLiveVersion
        PreviousLiveVersion = $previousLiveVersion
        ChannelId           = $ChannelId
        SiteId              = $config.SiteId
        ProjectId           = $config.ProjectId
        LiveUrl             = $liveUrl
        PromotedAt          = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir "live.json") -Encoding UTF8
}

Write-Host ""
Write-Host "Rollback (no rebuild, nothing deleted):" -ForegroundColor Yellow
if ($previousLiveVersion -and ($previousLiveVersion -cne $currentLiveVersion)) {
    Write-Host ("  {0}\rollback-live.ps1 -VersionId {1}" -f $PSScriptRoot, $previousLiveVersion) -ForegroundColor Yellow
} else {
    Write-Host "  Find the version to restore:" -ForegroundColor Yellow
    Write-Host ("    Firebase console -> Hosting -> Release history -> Version id") -ForegroundColor Yellow
    Write-Host ("    firebase hosting:channel:list --site {0} --project {1} --json" -f $config.SiteId, $config.ProjectId) -ForegroundColor Yellow
    Write-Host "      -> channels[].release.version.name = sites/<site>/versions/<VERSION_ID>" -ForegroundColor Yellow
    Write-Host ("  {0}\rollback-live.ps1 -VersionId <VERSION_ID>" -f $PSScriptRoot) -ForegroundColor Yellow
}
