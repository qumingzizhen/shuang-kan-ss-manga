[CmdletBinding(DefaultParameterSetName = "Start")]
param(
  [Parameter(ParameterSetName = "Start")]
  [ValidateRange(1, 65535)]
  [int]$WebPort = 3000,

  [Parameter(ParameterSetName = "Start")]
  [ValidateRange(5, 120)]
  [int]$StartupTimeoutSeconds = 40,

  [string]$CloudflaredPath = "E:\Programs\Cloudflared\cloudflared.exe",

  [ValidateSet("http2", "quic", "auto")]
  [string]$Protocol = "http2",

  [Parameter(ParameterSetName = "Stop", Mandatory = $true)]
  [switch]$Stop,

  [Parameter(ParameterSetName = "Status", Mandatory = $true)]
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StateDirectory = Join-Path $ProjectRoot ".data\quick-tunnel"
$PidFile = Join-Path $StateDirectory "cloudflared.pid"
$UrlFile = Join-Path $StateDirectory "public-url.txt"
$OriginPortFile = Join-Path $StateDirectory "origin-port.txt"
$StdoutLog = Join-Path $StateDirectory "cloudflared.stdout.log"
$StderrLog = Join-Path $StateDirectory "cloudflared.stderr.log"

function Get-SavedUrl {
  if (-not (Test-Path -LiteralPath $UrlFile)) {
    return $null
  }

  $value = (Get-Content -LiteralPath $UrlFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($value -match "^https://[a-z0-9-]+\.trycloudflare\.com/?$") {
    return $value.TrimEnd("/")
  }
  return $null
}

function Get-SavedOriginPort {
  if (-not (Test-Path -LiteralPath $OriginPortFile)) {
    return $null
  }

  $savedPort = 0
  if ([int]::TryParse(
    (Get-Content -LiteralPath $OriginPortFile -Raw -ErrorAction SilentlyContinue).Trim(),
    [ref]$savedPort
  )) {
    return $savedPort
  }
  return $null
}

function Get-ManagedTunnelProcess {
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

  try {
    $expectedPath = [System.IO.Path]::GetFullPath($CloudflaredPath)
    $actualPath = [System.IO.Path]::GetFullPath($process.Path)
    if (-not $actualPath.Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "PID $storedPid is not the managed cloudflared process. Refusing to stop it."
    }
  }
  catch {
    throw "Could not verify managed tunnel PID $storedPid. $($_.Exception.Message)"
  }

  return $process
}

function Remove-StaleState {
  foreach ($path in @($PidFile, $UrlFile, $OriginPortFile)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
}

function Test-PublicUrlReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$TimeoutSeconds = 8
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

if ($Status) {
  $managedProcess = Get-ManagedTunnelProcess
  if ($managedProcess) {
    $savedUrl = Get-SavedUrl
    $isReachable = $savedUrl -and (Test-PublicUrlReady -Url $savedUrl)
    if ($isReachable) {
      Write-Host "Quick Tunnel is healthy (PID $($managedProcess.Id))."
    }
    else {
      Write-Host "Quick Tunnel process is running but its public URL is unreachable (PID $($managedProcess.Id))." -ForegroundColor Yellow
    }
    if ($savedUrl) {
      Write-Host "Public URL: $savedUrl"
    }
    $savedOriginPort = Get-SavedOriginPort
    if ($savedOriginPort) {
      Write-Host "Local origin: http://127.0.0.1:$savedOriginPort"
    }
    return
  }

  Remove-StaleState
  Write-Host "Quick Tunnel is not running."
  return
}

if ($Stop) {
  $managedProcess = Get-ManagedTunnelProcess
  if ($managedProcess) {
    Write-Host "Stopping Quick Tunnel PID $($managedProcess.Id)..."
    Stop-Process -Id $managedProcess.Id -Force -ErrorAction Stop
    $managedProcess.WaitForExit(5000) | Out-Null
  }
  else {
    Write-Host "Quick Tunnel is already stopped."
  }

  Remove-StaleState
  Write-Host "Quick Tunnel stopped. The previous public URL is no longer valid."
  return
}

if (-not (Test-Path -LiteralPath $CloudflaredPath -PathType Leaf)) {
  throw "cloudflared was not found at '$CloudflaredPath'."
}

try {
  $originResponse = Invoke-WebRequest `
    -UseBasicParsing `
    -Uri "http://127.0.0.1:$WebPort" `
    -TimeoutSec 3
  if ([int]$originResponse.StatusCode -lt 200 -or [int]$originResponse.StatusCode -ge 500) {
    throw "Unexpected HTTP status $($originResponse.StatusCode)."
  }
}
catch {
  throw "The web console is not ready on http://127.0.0.1:$WebPort. Start it first with '.\scripts\dev.ps1 -Fresh'."
}

$existingProcess = Get-ManagedTunnelProcess
if ($existingProcess) {
  $savedUrl = Get-SavedUrl
  $savedOriginPort = Get-SavedOriginPort
  if ($savedOriginPort -ne $WebPort) {
    throw "Quick Tunnel is already running for port $savedOriginPort. Stop it before changing the origin port."
  }
  if ($savedUrl -and (Test-PublicUrlReady -Url $savedUrl)) {
    Write-Host "Quick Tunnel is already healthy (PID $($existingProcess.Id))."
    Write-Host "Public URL: $savedUrl"
    Write-Host "Local origin: http://127.0.0.1:$savedOriginPort"
    return
  }
  Write-Host "Replacing unhealthy Quick Tunnel PID $($existingProcess.Id)..." -ForegroundColor Yellow
  Stop-Process -Id $existingProcess.Id -Force -ErrorAction Stop
  $existingProcess.WaitForExit(5000) | Out-Null
  Remove-StaleState
}

Remove-StaleState
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
foreach ($path in @($StdoutLog, $StderrLog)) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

$argumentList = @(
  "tunnel",
  "--no-autoupdate",
  "--loglevel", "info",
  "--protocol", $Protocol,
  "--url", "http://127.0.0.1:$WebPort"
)

$process = Start-Process `
  -FilePath $CloudflaredPath `
  -ArgumentList $argumentList `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii
Set-Content -LiteralPath $OriginPortFile -Value $WebPort -Encoding ascii

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$publicUrl = $null
while ((Get-Date) -lt $deadline) {
  if ($process.HasExited) {
    break
  }

  $combinedLog = @(
    if (Test-Path -LiteralPath $StdoutLog) {
      Get-Content -LiteralPath $StdoutLog -Raw -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $StderrLog) {
      Get-Content -LiteralPath $StderrLog -Raw -ErrorAction SilentlyContinue
    }
  ) -join "`n"

  $match = [regex]::Match(
    $combinedLog,
    "https://[a-z0-9-]+\.trycloudflare\.com",
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if ($match.Success) {
    $publicUrl = $match.Value.ToLowerInvariant()
    break
  }

  Start-Sleep -Milliseconds 500
  $process.Refresh()
}

if (-not $publicUrl) {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-StaleState

  $errorTail = if (Test-Path -LiteralPath $StderrLog) {
    (Get-Content -LiteralPath $StderrLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
  }
  else {
    "No cloudflared error log was created."
  }
  throw "Quick Tunnel did not publish a URL within $StartupTimeoutSeconds seconds.`n$errorTail"
}

Set-Content -LiteralPath $UrlFile -Value $publicUrl -Encoding ascii

Write-Host ""
$readinessDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
while ((Get-Date) -lt $readinessDeadline) {
  if (Test-PublicUrlReady -Url $publicUrl) {
    break
  }
  Start-Sleep -Milliseconds 750
}
if (-not (Test-PublicUrlReady -Url $publicUrl)) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Remove-StaleState
  throw "Quick Tunnel published $publicUrl but the URL did not become reachable."
}

Write-Host "Quick Tunnel is ready over $Protocol."
Write-Host "Public URL: $publicUrl" -ForegroundColor Cyan
Write-Host "Local origin: http://127.0.0.1:$WebPort"
Write-Host "Anyone with this URL can open the site while the tunnel is running."
Write-Host "Keep the project, VPN, and this tunnel process running."
Write-Host "Stop it with: .\scripts\public-tunnel.ps1 -Stop"
