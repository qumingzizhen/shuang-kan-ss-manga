[CmdletBinding(DefaultParameterSetName = "Start")]
param(
  [Parameter(ParameterSetName = "Start")]
  [ValidateRange(1, 65535)]
  [int]$ApiPort = 8080,

  [Parameter(ParameterSetName = "Start")]
  [ValidateRange(5, 120)]
  [int]$StartupTimeoutSeconds = 30,

  [Parameter(ParameterSetName = "Stop", Mandatory = $true)]
  [switch]$Stop,

  [Parameter(ParameterSetName = "Status", Mandatory = $true)]
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$SourceProjectRoot = Split-Path -Parent $PSScriptRoot
$StateDirectory = Join-Path $SourceProjectRoot ".data\public-api"
$PidFile = Join-Path $StateDirectory "api.pid"
$PortFile = Join-Path $StateDirectory "port.txt"
$StdoutLog = Join-Path $StateDirectory "api.stdout.log"
$StderrLog = Join-Path $StateDirectory "api.stderr.log"
$ServerScript = Join-Path $SourceProjectRoot "services\dev-api\server.mjs"

function Remove-StaleState {
  foreach ($path in @($PidFile, $PortFile)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

function Get-SavedPort {
  if (-not (Test-Path -LiteralPath $PortFile -PathType Leaf)) {
    return $null
  }
  $savedPort = 0
  if ([int]::TryParse((Get-Content -LiteralPath $PortFile -Raw -ErrorAction SilentlyContinue).Trim(), [ref]$savedPort)) {
    return $savedPort
  }
  return $null
}

function Get-ManagedApiProcess {
  if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
    return $null
  }
  $storedPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim(), [ref]$storedPid)) {
    return $null
  }
  $process = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
  if (-not $process) {
    return $null
  }
  $expectedNodePath = [System.IO.Path]::GetFullPath((Get-Command node -ErrorAction Stop).Source)
  $actualNodePath = [System.IO.Path]::GetFullPath($process.Path)
  if (-not $actualNodePath.Equals($expectedNodePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "PID $storedPid is not the managed Node.js process. Refusing to stop it."
  }
  $processDetails = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction Stop
  $expectedServerFragment = [System.IO.Path]::GetFullPath($ServerScript)
  $commandLine = [string]$processDetails.CommandLine
  if ($commandLine.IndexOf($expectedServerFragment, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "PID $storedPid is not the managed public API process. Refusing to stop it."
  }
  return $process
}

function Test-ApiReady {
  param([Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutSeconds = 2)
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec $TimeoutSeconds
    return $result.service -eq "comic-platform-dev-api"
  }
  catch {
    return $false
  }
}

function Test-PortInUse {
  param([Parameter(Mandatory = $true)][int]$Port)
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

if ($Status) {
  $process = Get-ManagedApiProcess
  $savedPort = Get-SavedPort
  if ($process -and $savedPort -and (Test-ApiReady -Port $savedPort)) {
    Write-Host "Public API is running (PID $($process.Id))."
    Write-Host "Local API: http://127.0.0.1:$savedPort" -ForegroundColor Cyan
    return
  }
  if (-not $process) {
    Remove-StaleState
  }
  Write-Host "Public API is stopped or unhealthy."
  return
}

if ($Stop) {
  $process = Get-ManagedApiProcess
  if ($process) {
    Stop-Process -Id $process.Id -Force
    Write-Host "Public API stopped (PID $($process.Id))."
  }
  else {
    Write-Host "Public API is not running."
  }
  Remove-StaleState
  return
}

$existingProcess = Get-ManagedApiProcess
$savedPort = Get-SavedPort
if ($existingProcess -and $savedPort -eq $ApiPort -and (Test-ApiReady -Port $ApiPort)) {
  Write-Host "Reusing public API at http://127.0.0.1:$ApiPort (PID $($existingProcess.Id))."
  return
}
if ($existingProcess) {
  throw "A managed public API process is already running on port $savedPort. Stop it before changing ports."
}
Remove-StaleState

if (Test-PortInUse -Port $ApiPort) {
  if (Test-ApiReady -Port $ApiPort) {
    Write-Host "Reusing an existing compatible API at http://127.0.0.1:$ApiPort."
    return
  }
  throw "Port $ApiPort is already occupied by another service."
}

. (Join-Path $PSScriptRoot "dev-env.ps1")

$node = (Get-Command node -ErrorAction Stop).Source
$previousApiPort = $env:DEV_API_PORT
$previousBindHost = $env:DEV_API_BIND_HOST
$previousBackendApiUrl = $env:BACKEND_API_URL
$env:DEV_API_PORT = [string]$ApiPort
$env:DEV_API_BIND_HOST = "127.0.0.1"
$env:BACKEND_API_URL = "http://127.0.0.1:$ApiPort"

New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
foreach ($path in @($StdoutLog, $StderrLog)) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

try {
  $process = Start-Process `
    -FilePath $node `
    -ArgumentList @($ServerScript) `
    -WorkingDirectory $SourceProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru
}
finally {
  $env:DEV_API_PORT = $previousApiPort
  $env:DEV_API_BIND_HOST = $previousBindHost
  $env:BACKEND_API_URL = $previousBackendApiUrl
}

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii
Set-Content -LiteralPath $PortFile -Value $ApiPort -Encoding ascii

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  $process.Refresh()
  if ($process.HasExited) {
    break
  }
  if (Test-ApiReady -Port $ApiPort) {
    Write-Host "Public API is ready."
    Write-Host "Local API: http://127.0.0.1:$ApiPort" -ForegroundColor Cyan
    return
  }
  Start-Sleep -Milliseconds 500
}

if (-not $process.HasExited) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
Remove-StaleState
$errorTail = if (Test-Path -LiteralPath $StderrLog) {
  (Get-Content -LiteralPath $StderrLog -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
}
else {
  "No API error log was created."
}
throw "Public API did not become ready within $StartupTimeoutSeconds seconds.`n$errorTail"
