#requires -Version 5.1
<#
.SYNOPSIS
    Show the backend release state: service URL, traffic split, revisions,
    the local blue/green state file, and optionally the images in Artifact
    Registry.

.DESCRIPTION
    Read-only. Safe to run at any time, and the first thing to run when a
    rollback target is needed but the state file is missing.

.EXAMPLE
    .\scripts\gcp\status.ps1

.EXAMPLE
    .\scripts\gcp\status.ps1 -ShowImages -Limit 15
#>
[CmdletBinding()]
param(
    [string]$ProjectId,
    [string]$Region,
    [string]$Service,
    [string]$Repository,
    [string]$Image,
    [int]$Limit = 10,
    # Also list the tagged images kept in Artifact Registry (read-only).
    [switch]$ShowImages,
    # Do not call gcloud at all - just print the local state file.
    [switch]$LocalOnly
)

. (Join-Path $PSScriptRoot "common.ps1")

$config = Get-VectorGcpConfig -BoundParameters $PSBoundParameters
$state = Read-VectorState -Service $config.Service

Write-VectorBanner "Local state ($($config.Service))"
if ($state) {
    foreach ($name in @(
        "ProjectId", "Region", "Image", "Tag",
        "Blue", "PendingGreen", "GreenUrl", "GreenDeployedAt",
        "RollbackTarget", "LiveRevision", "PromotedAt", "RolledBackAt"
    )) {
        $value = Get-VectorStateValue -State $state -Name $name
        if ($value) { Write-Host ("  {0,-16}: {1}" -f $name, $value) }
    }
    Write-Host ("  {0,-16}: {1}" -f "(file)", (Get-VectorStatePath -Service $config.Service)) -ForegroundColor DarkGray
} else {
    Write-Host "  No state file yet. Every value can still be supplied with -Revision." -ForegroundColor Yellow
}

if ($LocalOnly) { exit 0 }

Write-VectorBanner "Cloud Run service"
$describe = Invoke-Gcloud -Arguments @(
    "run", "services", "describe", $config.Service,
    "--region", $config.Region,
    "--project", $config.ProjectId,
    "--format=json"
)
$service = $describe.Output | ConvertFrom-Json
Write-Host ("  url                : {0}" -f $service.status.url)
Write-Host ("  latest ready       : {0}" -f $service.status.latestReadyRevisionName)
Write-Host ("  latest created     : {0}" -f $service.status.latestCreatedRevisionName)

Write-Host ""
Write-Host "  Traffic split:" -ForegroundColor Cyan
$anyTraffic = $false
foreach ($entry in @($service.status.traffic)) {
    if ($null -eq $entry) { continue }
    $anyTraffic = $true
    $name = if ($entry.latestRevision -eq $true) { "$($entry.revisionName) (latest)" } else { $entry.revisionName }
    $tag = ""
    if ($entry.tag) { $tag = "  tag=$($entry.tag)" }
    Write-Host ("    {0,-6} %  {1}{2}" -f $entry.percent, $name, $tag)
}
if (-not $anyTraffic) { Write-Host "    <no traffic entries>" -ForegroundColor Yellow }

Write-VectorBanner "Revisions (newest first)"
Invoke-Gcloud -Arguments @(
    "run", "revisions", "list",
    "--service", $config.Service,
    "--region", $config.Region,
    "--project", $config.ProjectId,
    "--sort-by=~metadata.creationTimestamp",
    "--limit", "$Limit"
) | ForEach-Object { $_.Text } | Write-Host

Write-VectorBanner "Useful follow-ups"
Write-Host ("  verify green : {0}\verify-green.ps1" -f $PSScriptRoot)
Write-Host ("  promote      : {0}\promote-green.ps1" -f $PSScriptRoot)
Write-Host ("  rollback     : {0}\rollback.ps1 -Revision <REVISION>" -f $PSScriptRoot)
Write-Host "  logs         : gcloud logging read `"resource.type=cloud_run_revision AND resource.labels.service_name=$($config.Service)`" --project $($config.ProjectId) --limit 50 --freshness=1h"

if ($ShowImages) {
    $imagePath = "{0}/{1}/{2}" -f $config.RegistryHost, $config.ProjectId, $config.Repository
    Write-VectorBanner "Images in Artifact Registry ($imagePath)"
    Invoke-Gcloud -Arguments @(
        "artifacts", "docker", "images", "list", $imagePath,
        "--project", $config.ProjectId,
        "--include-tags",
        "--limit", "$Limit"
    ) | ForEach-Object { $_.Text } | Write-Host
    Write-Host "  (read-only listing - images are never deleted by these scripts)" -ForegroundColor DarkGray
}
