[CmdletBinding(DefaultParameterSetName = "Start")]
param(
  [Parameter(ParameterSetName = "Start")]
  [ValidateRange(1, 65535)]
  [int]$WebPort = 3100,

  [Parameter(ParameterSetName = "Start")]
  [ValidatePattern("^https?://")]
  [string]$BackendApiUrl = "http://127.0.0.1:8080",

  [Parameter(ParameterSetName = "Start")]
  [ValidateRange(10, 180)]
  [int]$StartupTimeoutSeconds = 60,

  [Parameter(ParameterSetName = "Start")]
  [switch]$SkipBuild,

  [Parameter(ParameterSetName = "Stop", Mandatory = $true)]
  [switch]$Stop,

  [Parameter(ParameterSetName = "Status", Mandatory = $true)]
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WebRoot = Join-Path $ProjectRoot "apps\web"
$NextCli = Join-Path $WebRoot "node_modules\next\dist\bin\next"
$StateDirectory = Join-Path $ProjectRoot ".data\public-web"
$PidFile = Join-Path $StateDirectory "next.pid"
$PortFile = Join-Path $StateDirectory "port.txt"
$StdoutLog = Join-Path $StateDirectory "next.stdout.log"
$StderrLog = Join-Path $StateDirectory "next.stderr.log"
$PublicDistDirectory = ".next-public"
$PublicBuildRoot = Join-Path $WebRoot $PublicDistDirectory
$StandaloneRoot = Join-Path $PublicBuildRoot "standalone"
$StandaloneServer = Join-Path $StandaloneRoot "server.js"

function Remove-StaleState {
  foreach ($path in @($PidFile, $PortFile)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

function Get-SavedPort {
  if (-not (Test-Path -LiteralPath $PortFile)) {
    return $null
  }

  $savedPort = 0
  if ([int]::TryParse(
    (Get-Content -LiteralPath $PortFile -Raw -ErrorAction SilentlyContinue).Trim(),
    [ref]$savedPort
  )) {
    return $savedPort
  }
  return $null
}

function Get-ManagedWebProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $null
  }

  $storedPid = 0
  if (-not [int]::TryParse(
    (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim(),
    [ref]$storedPid
  )) {
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
  $expectedServerFragment = [System.IO.Path]::GetFullPath($StandaloneServer)
  $commandLine = [string]$processDetails.CommandLine
  if ($commandLine.IndexOf($expectedServerFragment, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "PID $storedPid is not the managed Next.js production server. Refusing to stop it."
  }

  return $process
}

function Test-WebReady {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [int]$TimeoutSeconds = 3
  )

  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:$Port" `
      -TimeoutSec $TimeoutSeconds
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

if ($Status) {
  $managedProcess = Get-ManagedWebProcess
  if ($managedProcess) {
    $savedPort = Get-SavedPort
    Write-Host "Public production web is running (PID $($managedProcess.Id))."
    if ($savedPort) {
      Write-Host "Local origin: http://127.0.0.1:$savedPort"
    }
    return
  }

  Remove-StaleState
  Write-Host "Public production web is not running."
  return
}

if ($Stop) {
  $managedProcess = Get-ManagedWebProcess
  if ($managedProcess) {
    Write-Host "Stopping public production web PID $($managedProcess.Id)..."
    Stop-Process -Id $managedProcess.Id -Force -ErrorAction Stop
    $managedProcess.WaitForExit(5000) | Out-Null
  }
  else {
    Write-Host "Public production web is already stopped."
  }

  Remove-StaleState
  Write-Host "Public production web stopped."
  return
}

if (-not (Test-Path -LiteralPath $NextCli -PathType Leaf)) {
  throw "Next.js CLI was not found. Run npm install in '$WebRoot' first."
}

$existingProcess = Get-ManagedWebProcess
if ($existingProcess) {
  $savedPort = Get-SavedPort
  if ($savedPort -ne $WebPort) {
    throw "Public production web is already running on port $savedPort. Stop it before changing ports."
  }
  Write-Host "Public production web is already running (PID $($existingProcess.Id))."
  Write-Host "Local origin: http://127.0.0.1:$savedPort"
  return
}

if (Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $WebPort is already in use. Choose another port or stop the existing listener."
}

try {
  $healthResponse = Invoke-WebRequest `
    -UseBasicParsing `
    -Uri "$($BackendApiUrl.TrimEnd('/'))/health" `
    -TimeoutSec 5
  if ([int]$healthResponse.StatusCode -lt 200 -or [int]$healthResponse.StatusCode -ge 500) {
    throw "Unexpected HTTP status $($healthResponse.StatusCode)."
  }
}
catch {
  throw "The backend API is not ready at '$BackendApiUrl'. Start the project API before public access."
}

. (Join-Path $PSScriptRoot "dev-env.ps1")

$node = (Get-Command node -ErrorAction Stop).Source
$previousBackendApiUrl = $env:BACKEND_API_URL
$previousNextDistDir = $env:NEXT_DIST_DIR
$previousPort = $env:PORT
$previousHostname = $env:HOSTNAME
$env:BACKEND_API_URL = $BackendApiUrl.TrimEnd("/")
$env:NEXT_DIST_DIR = $PublicDistDirectory
$env:PORT = [string]$WebPort
$env:HOSTNAME = "127.0.0.1"

try {
  if (-not $SkipBuild) {
    Write-Host "Building the isolated production frontend..."
    $generatedConfigSnapshots = @{}
    foreach ($generatedConfigPath in @(
      (Join-Path $WebRoot "next-env.d.ts"),
      (Join-Path $WebRoot "tsconfig.json")
    )) {
      if (Test-Path -LiteralPath $generatedConfigPath -PathType Leaf) {
        $generatedConfigSnapshots[$generatedConfigPath] = [System.IO.File]::ReadAllBytes($generatedConfigPath)
      }
    }

    Push-Location $WebRoot
    try {
      & $node $NextCli build
      if ($LASTEXITCODE -ne 0) {
        throw "Next.js production build failed with exit code $LASTEXITCODE."
      }
    }
    finally {
      Pop-Location
      foreach ($snapshot in $generatedConfigSnapshots.GetEnumerator()) {
        [System.IO.File]::WriteAllBytes($snapshot.Key, $snapshot.Value)
      }
    }

    $staticSource = Join-Path $PublicBuildRoot "static"
    $staticDestination = Join-Path $StandaloneRoot "$PublicDistDirectory\static"
    if (-not (Test-Path -LiteralPath $staticSource -PathType Container)) {
      throw "Next.js static build output is missing at '$staticSource'."
    }
    New-Item -ItemType Directory -Path $staticDestination -Force | Out-Null
    Copy-Item -Path (Join-Path $staticSource "*") -Destination $staticDestination -Recurse -Force

    $publicSource = Join-Path $WebRoot "public"
    if (Test-Path -LiteralPath $publicSource -PathType Container) {
      $publicDestination = Join-Path $StandaloneRoot "public"
      New-Item -ItemType Directory -Path $publicDestination -Force | Out-Null
      Copy-Item -Path (Join-Path $publicSource "*") -Destination $publicDestination -Recurse -Force
    }
  }

  $buildId = Join-Path $PublicBuildRoot "BUILD_ID"
  if (
    -not (Test-Path -LiteralPath $buildId -PathType Leaf) -or
    -not (Test-Path -LiteralPath $StandaloneServer -PathType Leaf)
  ) {
    throw "Public standalone build is missing. Run without -SkipBuild first."
  }

  New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
  foreach ($path in @($StdoutLog, $StderrLog)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }

  $process = Start-Process `
    -FilePath $node `
    -ArgumentList @($StandaloneServer) `
    -WorkingDirectory $StandaloneRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru
}
finally {
  $env:BACKEND_API_URL = $previousBackendApiUrl
  $env:NEXT_DIST_DIR = $previousNextDistDir
  $env:PORT = $previousPort
  $env:HOSTNAME = $previousHostname
}

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii
Set-Content -LiteralPath $PortFile -Value $WebPort -Encoding ascii

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  $process.Refresh()
  if ($process.HasExited) {
    break
  }
  if (Test-WebReady -Port $WebPort) {
    Write-Host "Public production web is ready."
    Write-Host "Local origin: http://127.0.0.1:$WebPort" -ForegroundColor Cyan
    return
  }
  Start-Sleep -Milliseconds 500
}

if (-not $process.HasExited) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
Remove-StaleState

$errorTail = if (Test-Path -LiteralPath $StderrLog) {
  (Get-Content -LiteralPath $StderrLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
}
else {
  "No Next.js error log was created."
}
throw "Public production web did not become ready within $StartupTimeoutSeconds seconds.`n$errorTail"
