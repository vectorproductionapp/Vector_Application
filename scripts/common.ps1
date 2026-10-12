#requires -Version 5.1
<#
    Tool-agnostic helpers shared by scripts/gcp/*.ps1 and scripts/firebase/*.ps1.

    This file is always DOT-SOURCED by the two family-specific `common.ps1`
    files, never run on its own:

        . (Join-Path $PSScriptRoot "common.ps1")     # from scripts/gcp/...
        . (Join-Path $PSScriptRoot "common.ps1")     # from scripts/firebase/...

    Paths are captured into $script: variables at dot-source time so that no
    function has to rely on $PSScriptRoot resolving to this file when it is
    called later from a different script.

    Nothing in here deletes anything.
#>

$script:VectorRepoRoot = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------------------
# Native command plumbing
# ---------------------------------------------------------------------------

# Runs an external tool and returns
#   @{ ExitCode; Output; ErrorOutput; Text }
# where Output is stdout ONLY, ErrorOutput is stderr ONLY and Text is both.
#
# Keeping the streams apart matters: gcloud prints "WARNING: ..." style noise on
# stderr, and `--format=json` / `--format=value(...)` results are parsed by these
# scripts. Merging the streams would silently corrupt those values.
#
# PowerShell hands stderr lines to `2>&1` as ErrorRecord objects and stdout
# lines as strings, which is what makes the split possible without a .Process
# wrapper (and therefore works the same on Windows PowerShell 5.1 and pwsh 7).
#
# A non-zero exit throws unless -AllowFailure is given.
function Invoke-Native {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [string[]]$Arguments = @(),
        [switch]$AllowFailure
    )

    Write-Host ("  > " + $File + " " + ($Arguments -join " ")) -ForegroundColor DarkGray

    # Native commands write to stderr freely; that must not be promoted to a
    # terminating error just because the script sets $ErrorActionPreference.
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = "Continue"
    try {
        $captured = @(& $File @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } catch {
        $message = $_.Exception.Message
        if ($AllowFailure) {
            return [pscustomobject]@{ ExitCode = -1; Output = ""; ErrorOutput = $message; Text = $message }
        }
        throw "Failed to start '$File': $message"
    }

    $stdoutLines = New-Object System.Collections.Generic.List[string]
    $stderrLines = New-Object System.Collections.Generic.List[string]
    foreach ($item in $captured) {
        if ($item -is [System.Management.Automation.ErrorRecord]) { [void]$stderrLines.Add([string]$item) }
        else { [void]$stdoutLines.Add([string]$item) }
    }
    $stdout = ($stdoutLines -join [Environment]::NewLine).Trim()
    $stderr = ($stderrLines -join [Environment]::NewLine).Trim()

    # Text is for humans (and for URL scraping): stderr first, because that is
    # where tools report why they failed.
    $parts = @()
    if ($stderr) { $parts += $stderr }
    if ($stdout) { $parts += $stdout }
    $text = ($parts -join [Environment]::NewLine)

    if (($exitCode -ne 0) -and (-not $AllowFailure)) {
        throw ("{0} exited with code {1}:{2}{3}" -f $File, $exitCode, [Environment]::NewLine, $text)
    }
    return [pscustomobject]@{
        ExitCode    = [int]$exitCode
        Output      = $stdout
        ErrorOutput = $stderr
        Text        = $text
    }
}

function Invoke-Gcloud {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    $result = Invoke-Native -File "gcloud" -Arguments $Arguments -AllowFailure:$AllowFailure
    if (($result.ExitCode -ne 0) -and (-not $AllowFailure)) {
        throw ("gcloud exited with code {0}:{1}{2}" -f $result.ExitCode, [Environment]::NewLine, $result.Text)
    }
    return $result
}

function Test-Tool {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-VectorRepoRoot { return $script:VectorRepoRoot }

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

function Write-VectorBanner {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=== " + $Title + " ===") -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Configuration-file loading (templates only; real config is git-ignored)
# ---------------------------------------------------------------------------

# A config file is a .ps1 that ends with `return @{ ... }`. Returns $null when
# the file does not exist, throws when it exists but is malformed.
function Read-VectorHashtableFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Hint = "")
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $loaded = & $Path
    if ($loaded -isnot [System.Collections.IDictionary]) {
        $message = "$Path must end with `return @{ ... }`."
        if ($Hint) { $message = "$message $Hint" }
        throw $message
    }
    $result = @{}
    foreach ($key in @($loaded.Keys)) { $result[$key] = $loaded[$key] }
    return $result
}

# script parameter > environment variable > config file > default
function Merge-VectorConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][hashtable]$Base,
        [Parameter(Mandatory = $true)][hashtable]$EnvMap,
        [hashtable]$BoundParameters = @{},
        [hashtable]$FileValues = @{}
    )
    $merged = @{}
    foreach ($key in @($Base.Keys)) { $merged[$key] = $Base[$key] }
    foreach ($key in @($FileValues.Keys)) {
        if ($merged.ContainsKey($key)) { $merged[$key] = $FileValues[$key] }
    }
    foreach ($key in @($EnvMap.Keys)) {
        if (-not $merged.ContainsKey($key)) { continue }
        $value = [Environment]::GetEnvironmentVariable($EnvMap[$key])
        if (-not [string]::IsNullOrWhiteSpace($value)) { $merged[$key] = $value }
    }
    foreach ($key in @($BoundParameters.Keys)) {
        if (-not $merged.ContainsKey($key)) { continue }
        $value = $BoundParameters[$key]
        $isScalar = ($value -is [string]) -or ($value -isnot [System.Collections.IEnumerable])
        if ($isScalar -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
            $merged[$key] = $value
        }
    }
    return $merged
}

# ---------------------------------------------------------------------------
# HTTP probes
# ---------------------------------------------------------------------------

function Get-VectorHttpResponse {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [string]$Method = "GET",
        [int]$TimeoutSec = 20,
        [hashtable]$Headers = @{}
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Stop"
    try {
        $response = Invoke-WebRequest -Uri $Uri -Method $Method -TimeoutSec $TimeoutSec -UseBasicParsing -Headers $Headers
        return [pscustomobject]@{
            Ok      = $true
            Status  = [int]$response.StatusCode
            Body    = [string]$response.Content
            Headers = $response.Headers
            Error   = ""
        }
    } catch {
        $status = 0
        if ($_.Exception.PSObject.Properties["Response"] -and $_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = 0 }
        }
        return [pscustomobject]@{
            Ok      = $false
            Status  = $status
            Body    = ""
            Headers = $null
            Error   = $_.Exception.Message
        }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-HeaderValue {
    param($Headers, [string]$Name)
    if ($null -eq $Headers) { return $null }
    $value = $Headers[$Name]
    if ($null -eq $value) { return $null }
    if ($value -is [array]) { return $value[0] }
    return [string]$value
}

# Polls GET <base><healthPath> until it answers 200 with {"status":"ok"}.
function Test-VectorHealthEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [string]$HealthPath = "/health",
        [int]$Retries = 8,
        [int]$RetryDelaySeconds = 5,
        [int]$TimeoutSec = 20
    )
    $target = $BaseUrl.TrimEnd("/") + $HealthPath
    Write-Host ("  probing   : {0}" -f $target)

    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        $response = Get-VectorHttpResponse -Uri $target -TimeoutSec $TimeoutSec
        if ($response.Ok -and ($response.Status -eq 200) -and ($response.Body -match '"status"\s*:\s*"ok"')) {
            Write-Host ("  PASS: GET {0} -> 200 {1}" -f $target, $response.Body) -ForegroundColor Green
            return $true
        }
        $status = $response.Status
        $detail = if ($response.Body) { $response.Body } else { $response.Error }
        if ($attempt -lt $Retries) {
            Write-Host ("  attempt {0}/{1}: HTTP {2} ({3}) - retrying in {4}s" -f $attempt, $Retries, $status, $detail, $RetryDelaySeconds) -ForegroundColor DarkYellow
            Start-Sleep -Seconds $RetryDelaySeconds
        } else {
            Write-Host ("  FAILED: {0} -> HTTP {1} ({2})" -f $target, $status, $detail) -ForegroundColor Red
        }
    }
    return $false
}

# Sends a browser-style CORS preflight and requires our own origin back.
function Test-VectorCorsPreflight {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$Origin,
        [int]$TimeoutSec = 20
    )
    Write-Host ("  preflight : OPTIONS {0} from {1}" -f $BaseUrl, $Origin)
    $response = Get-VectorHttpResponse -Uri $BaseUrl -Method Options -TimeoutSec $TimeoutSec -Headers @{
        "Origin"                         = $Origin
        "Access-Control-Request-Method"  = "GET"
        "Access-Control-Request-Headers" = "authorization,content-type"
    }
    $allowed = Get-HeaderValue -Headers $response.Headers -Name "Access-Control-Allow-Origin"
    if ($allowed -eq $Origin) {
        Write-Host ("  PASS: Access-Control-Allow-Origin = {0}" -f $allowed) -ForegroundColor Green
        return $true
    }
    Write-Host ("  FAILED: expected Access-Control-Allow-Origin = {0}, got {1}" -f $Origin, $(if ($allowed) { $allowed } else { "<none>" })) -ForegroundColor Red
    Write-Host "  Check CORS_ORIGINS on the backend service (docs/gcp-firebase-blue-green.md)." -ForegroundColor Red
    return $false
}

# ---------------------------------------------------------------------------
# Confirmation gate
# ---------------------------------------------------------------------------

function Confirm-VectorAction {
    # Explicit human gate before anything moves production traffic or the live
    # channel. `exit` here ends the calling script, which is the intent.
    param(
        [Parameter(Mandatory = $true)][string]$Phrase,
        [Parameter(Mandatory = $true)][string]$Description,
        [switch]$Yes
    )
    if ($Yes) { return }
    Write-Host ""
    Write-Host $Description -ForegroundColor Yellow
    $answer = Read-Host ("Type '" + $Phrase + "' to continue, anything else to abort")
    if ($answer.Trim() -ne $Phrase) {
        Write-Host "Aborted - nothing was changed." -ForegroundColor Yellow
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Small JSON / URL helpers
# ---------------------------------------------------------------------------

function Find-JsonProperty {
    # Depth-first search for an object whose $Name property equals $Value.
    param($Node, [string]$Name, [string]$Value)
    if ($null -eq $Node) { return $null }
    if ($Node -is [string]) { return $null }
    if ($Node -is [System.Collections.IEnumerable]) {
        foreach ($item in $Node) {
            $found = Find-JsonProperty -Node $item -Name $Name -Value $Value
            if ($found) { return $found }
        }
        return $null
    }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        $property = $Node.PSObject.Properties[$Name]
        if ($property -and ([string]$property.Value -eq $Value)) { return $Node }
        foreach ($child in $Node.PSObject.Properties) {
            $found = Find-JsonProperty -Node $child.Value -Name $Name -Value $Value
            if ($found) { return $found }
        }
    }
    return $null
}

function Get-PreviewUrlFromText {
    # `site--channel-hash.web.app` is the preview shape; the bare live URL has
    # no "--" and is therefore ignored.
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $match = [regex]::Match($Text, "https://[a-z0-9-]+--[a-z0-9-]+\.web\.app")
    if ($match.Success) { return $match.Value }
    return $null
}
