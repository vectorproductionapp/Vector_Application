#requires -Version 5.1
<#
    Cloud Run blue/green helpers for scripts/gcp/*.ps1.

    Dot-source from a sibling script:

        . (Join-Path $PSScriptRoot "common.ps1")

    The tool-agnostic pieces (native command runs, HTTP probes, banners,
    confirmation gates, config-file loading) live one level up in
    scripts/common.ps1 and are pulled in below.

    Nothing here deletes a revision, an image, a bucket object or a Firebase
    resource - these scripts can only build, deploy, verify and move traffic.
#>

. (Join-Path (Split-Path -Parent $PSScriptRoot) "common.ps1")

# Captured at dot-source time so later function calls never depend on
# $PSScriptRoot resolving back to this file.
$script:VectorGcpRoot = $PSScriptRoot
$script:VectorGcpConfigFile = Join-Path $PSScriptRoot "config.ps1"
$script:VectorGcpExampleFile = Join-Path $PSScriptRoot "config.example.ps1"

# ---------------------------------------------------------------------------
# Configuration: parameter > environment > scripts/gcp/config.ps1 > default
# ---------------------------------------------------------------------------

function Get-VectorGcpConfig {
    [CmdletBinding()]
    param([hashtable]$BoundParameters = @{})

    # Built-in fallbacks = the values verified against vector-production-506505
    # on 2026-10-10. config.ps1 / env vars / parameters still override these.
    $defaults = @{
        ProjectId    = ""
        Region       = "asia-south1"
        Service      = "vector-application"
        Repository   = "cloud-run-source-deploy"
        Image        = "vector-api"
        Builder      = "docker"
        Source       = ""
        SiteId       = ""
        RegistryHost = ""
    }

    $fileValues = Read-VectorHashtableFile -Path $script:VectorGcpConfigFile `
        -Hint "Copy config.example.ps1 to config.ps1 and edit it." 

    $config = Merge-VectorConfig -Base $defaults -BoundParameters $BoundParameters `
        -FileValues $(if ($fileValues) { $fileValues } else { @{} }) `
        -EnvMap @{
            ProjectId  = "VECTOR_GCP_PROJECT"
            Region     = "VECTOR_GCP_REGION"
            Service    = "VECTOR_GCP_SERVICE"
            Repository = "VECTOR_GCP_REPOSITORY"
            Image      = "VECTOR_GCP_IMAGE"
            Builder    = "VECTOR_GCP_BUILDER"
            SiteId     = "VECTOR_FIREBASE_SITE"
        }

    if ([string]::IsNullOrWhiteSpace([string]$config.ProjectId)) {
        throw ("GCP project id is missing.`n" +
               "  Pass -ProjectId, or`n" +
               "  set VECTOR_GCP_PROJECT, or`n" +
               "  copy '{0}' to '{1}' and edit it." -f $script:VectorGcpExampleFile, $script:VectorGcpConfigFile)
    }
    if ([string]::IsNullOrWhiteSpace([string]$config.SiteId)) { $config.SiteId = $config.ProjectId }
    if ([string]::IsNullOrWhiteSpace([string]$config.Source)) {
        $config.Source = Join-Path (Get-VectorRepoRoot) "backend"
    }
    if ([string]::IsNullOrWhiteSpace([string]$config.RegistryHost)) {
        $config.RegistryHost = "{0}-docker.pkg.dev" -f $config.Region
    }
    if ($config.Builder -notin @("docker", "cloudbuild")) { $config.Builder = "docker" }

    return $config
}

# ---------------------------------------------------------------------------
# Local state file (git-ignored): which revision is green, and which revision
# a rollback must return to. Every value can also be supplied with -Revision,
# so losing this file is never fatal.
# ---------------------------------------------------------------------------

function Get-VectorStatePath {
    # Pure lookup: never creates anything, so a read-only status call leaves no
    # trace. Write-VectorState is what makes the directory.
    param([Parameter(Mandatory = $true)][string]$Service)
    $dir = Join-Path $script:VectorGcpRoot ".state"
    $safe = ($Service -replace "[^A-Za-z0-9_.-]", "_")
    return (Join-Path $dir ($safe + ".json"))
}

function Read-VectorState {
    param([Parameter(Mandatory = $true)][string]$Service)
    $path = Get-VectorStatePath -Service $Service
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
    } catch {
        Write-Warning "State file $path is unreadable; continuing without it."
        return $null
    }
}

function Write-VectorState {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][hashtable]$State
    )
    $path = Get-VectorStatePath -Service $Service
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Merge-VectorState {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][hashtable]$Values
    )
    $merged = @{}
    $existing = Read-VectorState -Service $Service
    if ($existing) {
        foreach ($property in $existing.PSObject.Properties) { $merged[$property.Name] = $property.Value }
    }
    foreach ($key in @($Values.Keys)) { $merged[$key] = $Values[$key] }
    return (Write-VectorState -Service $Service -State $merged)
}

function Get-VectorStateValue {
    # Returns $null rather than throwing when the state file does not exist yet
    # or the key was never recorded - a missing state file is a normal state,
    # not an error.
    param(
        [AllowNull()]$State,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $State) { return $null }
    $property = $State.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    if ([string]::IsNullOrWhiteSpace([string]$property.Value)) { return $null }
    return $property.Value
}

# ---------------------------------------------------------------------------
# Cloud Run helpers
# ---------------------------------------------------------------------------

function Get-VectorLiveRevision {
    # The revision that currently receives production traffic (highest share
    # above zero). Authoritative - read from Cloud Run, not from local state.
    param([Parameter(Mandatory = $true)]$Config)

    $result = Invoke-Gcloud -Arguments @(
        "run", "services", "describe", $Config.Service,
        "--region", $Config.Region,
        "--project", $Config.ProjectId,
        "--format=json"
    )
    $describe = $result.Output | ConvertFrom-Json

    $bestName = $null
    $bestPercent = -1
    $followLatest = $false
    foreach ($entry in @($describe.status.traffic)) {
        if ($null -eq $entry) { continue }
        if ($entry.latestRevision -eq $true) { $followLatest = $true }
        $percent = 0
        if ($null -ne $entry.percent) { $percent = [int]$entry.percent }
        if (($percent -gt $bestPercent) -and ($percent -gt 0) -and $entry.revisionName) {
            $bestPercent = $percent
            $bestName = $entry.revisionName
        }
    }
    if (-not $bestName -and $followLatest) {
        $bestName = $describe.status.latestReadyRevisionName
    }
    return [pscustomobject]@{
        Revision = $bestName
        Percent  = $bestPercent
        Url      = $describe.status.url
    }
}

function Get-VectorRevisionUrl {
    # Cloud Run does NOT populate status.url on revisions, so a revision's
    # hostname can only be read out of the SERVICE's traffic array. Tagged
    # entries always carry a url; untagged ones (retired, 0% traffic) do not.
    #
    # Pass -Tag "green" to target a tagged revision, otherwise the entry whose
    # revisionName matches -Revision is used.
    param(
        [Parameter(Mandatory = $true)]$Config,
        [string]$Revision = "",
        [string]$Tag = ""
    )
    $result = Invoke-Gcloud -Arguments @(
        "run", "services", "describe", $Config.Service,
        "--region", $Config.Region,
        "--project", $Config.ProjectId,
        "--format=json"
    )
    $svc = $result.Output | ConvertFrom-Json
    foreach ($entry in @($svc.status.traffic)) {
        if ($null -eq $entry) { continue }
        if (-not [string]::IsNullOrWhiteSpace($Tag)) {
            if (($entry.tag -eq $Tag) -and $entry.url) { return $entry.url }
        }
        elseif ($Revision -and ($entry.revisionName -eq $Revision) -and $entry.url) {
            return $entry.url
        }
    }
    return ""
}

function Get-VectorGreenRevision {
    # -Revision wins, then the local state file.
    param(
        [Parameter(Mandatory = $true)]$Config,
        [string]$Revision = ""
    )
    if (-not [string]::IsNullOrWhiteSpace($Revision)) { return $Revision }
    $state = Read-VectorState -Service $Config.Service
    $fromState = Get-VectorStateValue -State $state -Name "PendingGreen"
    if ($fromState) { return $fromState }
    return $null
}
