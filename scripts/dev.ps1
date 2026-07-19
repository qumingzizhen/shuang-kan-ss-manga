param(
  [int]$ApiPort = 8080,
  [int]$WebPort = 3000,
  [switch]$Fresh,
  [switch]$NoAutoPort
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

.\scripts\dev-env.ps1

function Get-ListeningProcessIds {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -gt 0 }
  )
}

function Test-PortInUse {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500, $false)) {
      return $false
    }

    $client.EndConnect($connect)
    return $true
  }
  catch {
    return $false
  }
  finally {
    $client.Close()
  }
}

function Test-DevApi {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    return $result.service -eq "comic-platform-dev-api"
  }
  catch {
    return $false
  }
}

function Test-WebConsole {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port" -TimeoutSec 2
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

function Stop-PortListeners {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  foreach ($processId in @(Get-ListeningProcessIds -Port $Port)) {
    Write-Host "Stopping $Label listener PID $processId on port $Port"
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    }
    catch {
      # Stopping the web process can trigger dev.ps1's finally block, which may
      # stop the API process before this loop reaches it. Treat that race as a
      # successful stop, but keep surfacing real permission/process failures.
      if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
        throw
      }
      Write-Host "$Label listener PID $processId already stopped."
    }
  }
}

function Wait-ForPortRelease {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [int]$TimeoutSeconds = 10
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortInUse -Port $Port)) {
      return
    }
    Start-Sleep -Milliseconds 200
  }

  throw "$Label port $Port did not become available after stopping its listener."
}

function Get-AvailablePort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$PreferredPort,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if (-not (Test-PortInUse -Port $PreferredPort)) {
    return $PreferredPort
  }

  if ($NoAutoPort) {
    throw "$Label port $PreferredPort is already in use. Close the existing process, pass another port, or run .\scripts\dev.ps1 -Fresh."
  }

  for ($port = $PreferredPort + 1; $port -lt ($PreferredPort + 100); $port++) {
    if (-not (Test-PortInUse -Port $port)) {
      Write-Host "$Label port $PreferredPort is already in use; using $port instead."
      return $port
    }
  }

  throw "Could not find a free $Label port near $PreferredPort."
}

function Wait-ForDevApi {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-DevApi -Port $Port) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }

  return $false
}

function Start-ApiProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ApiUrl
  )

  $node = (Get-Command node -ErrorAction Stop).Source
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node
  $startInfo.Arguments = "services\dev-api\server.mjs"
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false

  # Windows can expose both PATH and Path in one process environment. Building a
  # clean environment avoids Start-Process/.NET duplicate-key failures.
  $startInfo.EnvironmentVariables.Clear()
  $seen = @{}
  $pathValue = $env:Path
  if (-not $pathValue) {
    $pathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
  }
  if ($pathValue) {
    $startInfo.EnvironmentVariables["Path"] = $pathValue
    $seen["PATH"] = $true
  }

  $processEnvironment = [Environment]::GetEnvironmentVariables("Process")
  foreach ($key in $processEnvironment.Keys) {
    $name = [string]$key
    $canonicalName = $name.ToUpperInvariant()
    if ($seen.ContainsKey($canonicalName)) {
      continue
    }

    $seen[$canonicalName] = $true
    $startInfo.EnvironmentVariables[$name] = [string]$processEnvironment[$key]
  }

  $startInfo.EnvironmentVariables["DEV_API_PORT"] = [string]$ApiPort
  $startInfo.EnvironmentVariables["NEXT_PUBLIC_API_BASE"] = $ApiUrl

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Failed to start development API shim."
  }

  return $process
}

if ($Fresh) {
  Stop-PortListeners -Port $WebPort -Label "web"
  Stop-PortListeners -Port $ApiPort -Label "API"
  Wait-ForPortRelease -Port $WebPort -Label "Web"
  Wait-ForPortRelease -Port $ApiPort -Label "API"
}

$reuseApi = $false
$reuseWeb = $false

if (Test-PortInUse -Port $ApiPort) {
  if (Test-DevApi -Port $ApiPort) {
    $reuseApi = $true
  }
  else {
    $ApiPort = Get-AvailablePort -PreferredPort $ApiPort -Label "API"
  }
}

if (Test-PortInUse -Port $WebPort) {
  if ($reuseApi -and (Test-WebConsole -Port $WebPort)) {
    $reuseWeb = $true
  }
  else {
    $WebPort = Get-AvailablePort -PreferredPort $WebPort -Label "Web"
  }
}

$apiUrl = "http://127.0.0.1:$ApiPort"
$webUrl = "http://127.0.0.1:$WebPort"

if ($reuseApi) {
  Write-Host "Reusing existing development API at $apiUrl"
}

if ($reuseWeb) {
  Write-Host "Existing web console is already running at $webUrl"
  Write-Host "Open $webUrl"
  Write-Host "Run .\scripts\dev.ps1 -Fresh if you want to restart and load the newest code."
  return
}

$env:DEV_API_PORT = [string]$ApiPort
$env:NEXT_PUBLIC_API_BASE = $apiUrl

$apiProcess = $null

if (-not $reuseApi) {
  Write-Host "Starting development API shim at $apiUrl"
  $apiProcess = Start-ApiProcess -ApiUrl $apiUrl

  if (-not (Wait-ForDevApi -Port $ApiPort)) {
    throw "Development API shim did not become healthy on $apiUrl"
  }
}

try {
  Write-Host "Starting web console at $webUrl"
  Write-Host "Press Ctrl+C to stop the web console."
  if ($apiProcess) {
    Write-Host "This terminal will also stop the API shim it started."
  }
  else {
    Write-Host "The existing API shim will keep running after this terminal closes."
  }
  npm --prefix .\apps\web run dev -- --hostname 127.0.0.1 --port $WebPort
}
finally {
  if ($apiProcess -and -not $apiProcess.HasExited) {
    Write-Host "Stopping development API shim..."
    Stop-Process -Id $apiProcess.Id -Force
  }
}
