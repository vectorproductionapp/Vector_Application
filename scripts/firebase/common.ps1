#requires -Version 5.1
<#
    Firebase Hosting helpers for scripts/firebase/*.ps1.

    Dot-source from a sibling script:

        . (Join-Path $PSScriptRoot "common.ps1")

    The tool-agnostic pieces live one level up in scripts/common.ps1 and are
    pulled in below. Nothing here ever writes to the "live" channel - only
    promote-live.ps1 and rollback-live.ps1 do, and both ask for typed
    confirmation first.
#>

. (Join-Path (Split-Path -Parent $PSScriptRoot) "common.ps1")

# Captured at dot-source time so later function calls never depend on
# $PSScriptRoot resolving back to this file.
$script:VectorFirebaseRoot = $PSScriptRoot
$script:VectorFirebaseConfigFile = Join-Path $PSScriptRoot "config.ps1"
$script:VectorFirebaseExampleFile = Join-Path $PSScriptRoot "config.example.ps1"

function Invoke-Firebase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    $result = Invoke-Native -File "firebase" -Arguments $Arguments -AllowFailure:$AllowFailure
    if (($result.ExitCode -ne 0) -and (-not $AllowFailure)) {
        throw ("firebase exited with code {0}:{1}{2}" -f $result.ExitCode, [Environment]::NewLine, $result.Text)
    }
    return $result
}

function Get-VectorFirebaseConfig {
    [CmdletBinding()]
    param([hashtable]$BoundParameters = @{})

    $defaults = @{
        ProjectId  = ""
        SiteId     = ""
        ApiBaseUrl = ""
        WsBaseUrl  = ""
        ChannelTtl = "7d"
    }

    $fileValues = Read-VectorHashtableFile -Path $script:VectorFirebaseConfigFile `
        -Hint "Copy config.example.ps1 to config.ps1 and edit it."

    $config = Merge-VectorConfig -Base $defaults -BoundParameters $BoundParameters `
        -FileValues $(if ($fileValues) { $fileValues } else { @{} }) `
        -EnvMap @{
            ProjectId  = "VECTOR_GCP_PROJECT"
            SiteId     = "VECTOR_FIREBASE_SITE"
            ApiBaseUrl = "REACT_APP_API_BASE_URL"
            WsBaseUrl  = "REACT_APP_WS_BASE_URL"
        }

    # Fall back to .firebaserc so a fresh clone still knows the project.
    if ([string]::IsNullOrWhiteSpace([string]$config.ProjectId)) {
        $firebaserc = Join-Path (Get-VectorRepoRoot) ".firebaserc"
        if (Test-Path -LiteralPath $firebaserc) {
            try {
                $rc = Get-Content -LiteralPath $firebaserc -Raw | ConvertFrom-Json
                if ($rc.projects.default) { $config.ProjectId = [string]$rc.projects.default }
            } catch {
                # Ignore a malformed .firebaserc; the operator will be asked.
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace([string]$config.ProjectId)) {
        throw ("Firebase project id is missing.`n" +
               "  Pass -ProjectId, set VECTOR_GCP_PROJECT, or copy '{0}' to '{1}'." -f $script:VectorFirebaseExampleFile, $script:VectorFirebaseConfigFile)
    }

    # Default Hosting site id == Firebase project id for the default site.
    if ([string]::IsNullOrWhiteSpace([string]$config.SiteId)) { $config.SiteId = $config.ProjectId }
    return $config
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# `npm ci` + `npm run build` with the API/WebSocket URLs inlined at build time.
# CRA bakes REACT_APP_* into the bundle: the same commit with different URLs
# produces a different bundle, which is exactly why preview and live can point
# at different backends.
function Invoke-FrontendBuild {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Config,
        [switch]$SkipInstall
    )
    $repoRoot = Get-VectorRepoRoot
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "package.json"))) {
        throw "package.json not found in $repoRoot - run this from the repository."
    }

    $previousApi = $env:REACT_APP_API_BASE_URL
    $previousWs = $env:REACT_APP_WS_BASE_URL
    Push-Location $repoRoot
    try {
        if (-not $SkipInstall) {
            Write-VectorBanner "npm ci"
            Invoke-Native -File "npm" -Arguments @("ci") | Out-Null
        }

        if ([string]::IsNullOrWhiteSpace([string]$Config.ApiBaseUrl)) {
            throw ("REACT_APP_API_BASE_URL is not set.`n" +
                   "Pass -ApiBaseUrl, set REACT_APP_API_BASE_URL, or put ApiBaseUrl in scripts/firebase/config.ps1.`n" +
                   "Without it the bundle calls relative URLs, Firebase Hosting rewrites them to index.html, and login breaks.")
        }
        $env:REACT_APP_API_BASE_URL = $Config.ApiBaseUrl
        if (-not [string]::IsNullOrWhiteSpace([string]$Config.WsBaseUrl)) {
            $env:REACT_APP_WS_BASE_URL = $Config.WsBaseUrl
        } else {
            Remove-Item -Path Env:REACT_APP_WS_BASE_URL -ErrorAction SilentlyContinue
        }

        Write-VectorBanner "npm run build"
        Write-Host ("  REACT_APP_API_BASE_URL = {0}" -f $Config.ApiBaseUrl) -ForegroundColor DarkGray
        if ($Config.WsBaseUrl) { Write-Host ("  REACT_APP_WS_BASE_URL  = {0}" -f $Config.WsBaseUrl) -ForegroundColor DarkGray }
        Invoke-Native -File "npm" -Arguments @("run", "build") | Out-Null
    } finally {
        Pop-Location
        if ($null -ne $previousApi) { $env:REACT_APP_API_BASE_URL = $previousApi } else { Remove-Item -Path Env:REACT_APP_API_BASE_URL -ErrorAction SilentlyContinue }
        if ($null -ne $previousWs) { $env:REACT_APP_WS_BASE_URL = $previousWs } else { Remove-Item -Path Env:REACT_APP_WS_BASE_URL -ErrorAction SilentlyContinue }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "build\index.html"))) {
        throw "build\index.html was not produced - the frontend build failed."
    }
    Write-Host "  build\index.html present." -ForegroundColor Green
}

function Get-VectorHostingSite {
    # `hosting:channel:deploy` has NO --site option (firebase-tools 15): it
    # resolves the site from firebase.json's `hosting.site`, or from the
    # project's default Hosting site. Every other Hosting command these scripts
    # run takes an explicit --site, so both must resolve to the same site or a
    # preview would be promoted from a channel that lives elsewhere.
    param([Parameter(Mandatory = $true)]$Config)

    $resolved = ""
    $firebaseJson = Join-Path (Get-VectorRepoRoot) "firebase.json"
    if (Test-Path -LiteralPath $firebaseJson) {
        try {
            $cfg = Get-Content -LiteralPath $firebaseJson -Raw | ConvertFrom-Json
            if ($cfg.hosting -and $cfg.hosting.site) { $resolved = [string]$cfg.hosting.site }
        } catch {
            # A malformed firebase.json is reported by the firebase CLI itself.
        }
    }
    if ([string]::IsNullOrWhiteSpace($resolved)) { $resolved = [string]$Config.ProjectId }
    return $resolved
}

function Get-HostingChannelNode {
    # A Hosting Channel resource has no "channelId" field - the id is the last
    # segment of `name` ("sites/<site>/channels/<channelId>"). Matching on a
    # "channelId" property would never hit.
    param($Json, [Parameter(Mandatory = $true)][string]$ChannelId)
    if ($null -eq $Json) { return $null }

    $candidates = $Json
    $channelsProp = $Json.PSObject.Properties["channels"]
    if ($channelsProp -and $channelsProp.Value) { $candidates = $channelsProp.Value }

    foreach ($ch in @($candidates)) {
        if ($null -eq $ch) { continue }
        $nameProp = $ch.PSObject.Properties["name"]
        if ($nameProp -and $nameProp.Value) {
            $segments = ([string]$nameProp.Value) -split "/"
            if ($segments[$segments.Count - 1] -ceq $ChannelId) { return $ch }
        }
        $idProp = $ch.PSObject.Properties["channelId"]
        if ($idProp -and $idProp.Value -and ([string]$idProp.Value -ceq $ChannelId)) { return $ch }
    }
    return $null
}

function Get-HostingChannelVersion {
    # `release.version.name` on a channel is "sites/<site>/versions/<VERSION_ID>"
    # - the id rollback-live.ps1 -VersionId needs. Returns "" when unknown.
    param($Channel)
    if ($null -eq $Channel) { return "" }
    $relProp = $Channel.PSObject.Properties["release"]
    if (-not $relProp -or -not $relProp.Value) { return "" }
    $verProp = $relProp.Value.PSObject.Properties["version"]
    if (-not $verProp -or -not $verProp.Value) { return "" }
    $nameProp = $verProp.Value.PSObject.Properties["name"]
    if (-not $nameProp -or -not $nameProp.Value) { return "" }
    $segments = ([string]$nameProp.Value) -split "/"
    if ($segments.Count -eq 0) { return "" }
    return [string]$segments[$segments.Count - 1]
}

function Get-ChannelUrl {
    # Deploy output first, then `hosting:channel:list --json`.
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$ChannelId,
        [string]$DeployOutput = ""
    )
    $fromOutput = Get-PreviewUrlFromText -Text $DeployOutput
    if ($fromOutput) { return $fromOutput }

    $node = Get-HostingChannelFromSite -Config $Config -ChannelId $ChannelId
    if ($node) {
        $urlProperty = $node.PSObject.Properties["url"]
        if ($urlProperty -and $urlProperty.Value) { return [string]$urlProperty.Value }
    }
    return $null
}

function Get-HostingChannelFromSite {
    # Reads `hosting:channel:list --json` and returns the raw channel object.
    # -AllowFailure: this is a best-effort fallback, never a hard error.
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$ChannelId
    )
    $list = Invoke-Firebase -Arguments @(
        "hosting:channel:list", "--site", $Config.SiteId, "--project", $Config.ProjectId, "--json"
    ) -AllowFailure
    if ($list.ExitCode -ne 0) { return $null }
    try {
        $parsed = $list.Output | ConvertFrom-Json
        return Get-HostingChannelNode -Json $parsed -ChannelId $ChannelId
    } catch {
        Write-Warning "Could not parse `"firebase hosting:channel:list --json`" output."
        return $null
    }
}
