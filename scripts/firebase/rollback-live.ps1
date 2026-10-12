#requires -Version 5.1
<#
.SYNOPSIS
    Roll the LIVE Firebase Hosting channel back to a previously released
    version - no rebuild, no re-upload, and nothing is deleted.

.DESCRIPTION
    Firebase Hosting keeps every release's version, so a rollback is a clone of
    an old version back onto the live channel:

        firebase hosting:clone <site>@<VERSION_ID> <site>:live

    NOTE the separators differ: firebase-tools splits the source on ":" FIRST,
    so "<site>:<x>" is ALWAYS a channel. A version id must use "@" (see
    firebase-tools/lib/commands/hosting-clone.js).

    Find VERSION_IDs with:

        Firebase console -> Hosting -> Release history -> Version
        firebase hosting:channel:list --site <site> --project <project> --json
            -> channels[].release.version.name = sites/<site>/versions/<id>

    (The CLI can only show each channel's CURRENT version; the full release
    history lives in the console. There is no `hosting:releases:list`.)

    Alternative without a version id: pass -ChannelId to roll live back to
    whatever a known-good preview channel currently holds.

    If neither is supplied the script prints the instructions and exits without
    changing anything - it will never guess a version.

.EXAMPLE
    .\scripts\firebase\rollback-live.ps1 -VersionId clieabcd1234

.EXAMPLE
    .\scripts\firebase\rollback-live.ps1 -ChannelId green-20261008-101500 -Yes
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$SiteId,
    # Hosting version id to put back on the live channel.
    [string]$VersionId,
    # Or: roll live back to the current contents of this preview channel.
    [string]$ChannelId,
    [switch]$Yes
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorFirebaseConfig -BoundParameters $PSBoundParameters

$source = ""
$sourceLabel = ""
if (-not [string]::IsNullOrWhiteSpace($VersionId)) {
    # "@" not ":" - a version is only recognised with the at-sign separator.
    $source = $config.SiteId + "@" + $VersionId
    $sourceLabel = "version " + $VersionId
} elseif (-not [string]::IsNullOrWhiteSpace($ChannelId)) {
    if ($ChannelId -eq "live") { throw "-ChannelId must be a preview channel, not 'live'." }
    $source = $config.SiteId + ":" + $ChannelId
    $sourceLabel = "preview channel " + $ChannelId
}

Write-VectorBanner "Live channel rollback"
Write-Host ("  project : {0}" -f $config.ProjectId)
Write-Host ("  site    : {0}" -f $config.SiteId)

if (-not $source) {
    Write-Host ""
    Write-Host "No rollback source given, and this script will not guess a version." -ForegroundColor Red

    # The last promote-live.ps1 records what is live and what came before it.
    # Show it so the operator can copy it, but still require it explicitly.
    $stateFile = Join-Path $script:VectorFirebaseRoot ".state\live.json"
    $recordedCurrent = ""
    $recordedPrevious = ""
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $recorded = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
            if ($recorded.CurrentLiveVersion) { $recordedCurrent = [string]$recorded.CurrentLiveVersion }
            if ($recorded.PreviousLiveVersion) { $recordedPrevious = [string]$recorded.PreviousLiveVersion }
        } catch { }
    }
    if ($recordedCurrent -or $recordedPrevious) {
        Write-Host ""
        Write-Host "Recorded by the last promote-live.ps1:" -ForegroundColor Yellow
        if ($recordedCurrent) { Write-Host ("  current  : {0}" -f $recordedCurrent) }
        if ($recordedPrevious) { Write-Host ("  previous : {0}  <- rollback target" -f $recordedPrevious) }
    }

    Write-Host ""
    Write-Host "Find the version to restore:" -ForegroundColor Yellow
    Write-Host "  Firebase console -> Hosting -> Release history -> Version id (clie...)"
    Write-Host ("  current version of each channel: firebase hosting:channel:list --site {0} --project {1} --json" -f $config.SiteId, $config.ProjectId)
    Write-Host "    -> channels[].release.version.name = sites/<site>/versions/<VERSION_ID>"
    Write-Host ""
    Write-Host "Then re-run with one of:" -ForegroundColor Yellow
    if ($recordedPrevious) {
        Write-Host ("  {0}\rollback-live.ps1 -VersionId {1}" -f $PSScriptRoot, $recordedPrevious) -ForegroundColor Yellow
    }
    Write-Host ("  {0}\rollback-live.ps1 -VersionId <VERSION_ID>" -f $PSScriptRoot)
    Write-Host ("  {0}\rollback-live.ps1 -ChannelId <PREVIEW_CHANNEL>" -f $PSScriptRoot)
    exit 1
}

Write-Host ("  source  : {0}" -f $sourceLabel)
Write-Host ("  target  : {0}:live" -f $config.SiteId)
Write-Host ""
Write-Host "Rollback does not delete any release; the current live version stays" -ForegroundColor Yellow
Write-Host "available in Hosting's release history, so this is reversible." -ForegroundColor Yellow

# Note what is live before replacing it, so this rollback can itself be undone.
$liveBefore = ""
try { $liveBefore = Get-HostingChannelVersion -Channel (Get-HostingChannelFromSite -Config $config -ChannelId "live") } catch { }

Confirm-VectorAction -Phrase "rollback" -Yes:$Yes -Description (
    "About to make " + $sourceLabel + " the LIVE contents of site '" + $config.SiteId + "'."
)

$clone = Invoke-Firebase -Arguments @(
    "hosting:clone", $source, ($config.SiteId + ":live"),
    "--project", $config.ProjectId,
    "--non-interactive"
)
Write-Host $clone.Text

$liveAfter = ""
try { $liveAfter = Get-HostingChannelVersion -Channel (Get-HostingChannelFromSite -Config $config -ChannelId "live") } catch { }

if ($liveBefore -or $liveAfter) {
    $stateDir = Join-Path $script:VectorFirebaseRoot ".state"
    if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
    @{
        CurrentLiveVersion  = $liveAfter
        PreviousLiveVersion = $liveBefore
        SiteId              = $config.SiteId
        ProjectId           = $config.ProjectId
        LiveUrl             = ("https://{0}.web.app" -f $config.SiteId)
        RolledBackAt        = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir "live.json") -Encoding UTF8
}

Write-VectorBanner "Live channel restored"
Write-Host ("  url : https://{0}.web.app" -f $config.SiteId) -ForegroundColor Green
if ($liveAfter) { Write-Host ("  now serving version : {0}" -f $liveAfter) -ForegroundColor Green }
if ($liveBefore -and ($liveBefore -cne $liveAfter)) {
    Write-Host ("  rolled away from    : {0}  (clone it back to undo)" -f $liveBefore) -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "Verify in a private window (index.html is served no-cache):" -ForegroundColor Yellow
Write-Host ("  https://{0}.web.app" -f $config.SiteId)
