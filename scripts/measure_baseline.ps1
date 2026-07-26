param(
  [int]$Samples = 12,
  [switch]$SkipUnitTests,
  [switch]$SkipBuild,
  [string]$ApiBaseUrl = "http://127.0.0.1:8080",
  [string]$WebBaseUrl = "http://127.0.0.1:3000",
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
.\scripts\dev-env.ps1

if ($Samples -lt 3 -or $Samples -gt 200) {
  throw "Samples must be between 3 and 200."
}

function Invoke-MeasuredCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  & $Command | Out-Host
  $exitCode = $LASTEXITCODE
  $stopwatch.Stop()

  if ($exitCode -ne 0) {
    throw "$Name failed with exit code $exitCode."
  }

  [ordered]@{
    name = $Name
    duration_ms = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
    exit_code = $exitCode
  }
}

function Get-DirectorySizeBytes {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return 0
  }

  [long](
    Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum
  ).Sum
}

function Get-Percentile {
  param(
    [Parameter(Mandatory = $true)]
    [double[]]$Values,
    [Parameter(Mandatory = $true)]
    [double]$Percentile
  )

  $sorted = @($Values | Sort-Object)
  if (-not $sorted.Count) {
    return $null
  }

  $index = [math]::Ceiling(($sorted.Count - 1) * $Percentile)
  [math]::Round($sorted[$index], 2)
}

function Measure-HttpEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [Parameter(Mandatory = $true)]
    [int]$Count
  )

  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5 | Out-Null
  }
  catch {
    return [ordered]@{
      name = $Name
      uri = $Uri
      available = $false
      error = $_.Exception.Message
    }
  }

  $durations = New-Object System.Collections.Generic.List[double]
  $statusCode = 0
  for ($index = 0; $index -lt $Count; $index++) {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 10
    $stopwatch.Stop()
    $statusCode = [int]$response.StatusCode
    $durations.Add($stopwatch.Elapsed.TotalMilliseconds)
  }

  [ordered]@{
    name = $Name
    uri = $Uri
    available = $true
    status_code = $statusCode
    samples = $Count
    min_ms = [math]::Round(($durations | Measure-Object -Minimum).Minimum, 2)
    p50_ms = Get-Percentile -Values $durations.ToArray() -Percentile 0.50
    p95_ms = Get-Percentile -Values $durations.ToArray() -Percentile 0.95
    max_ms = [math]::Round(($durations | Measure-Object -Maximum).Maximum, 2)
  }
}

$commands = New-Object System.Collections.Generic.List[object]
if (-not $SkipUnitTests) {
  $commands.Add((Invoke-MeasuredCommand -Name "web_unit_tests" -Command {
    npm --prefix .\apps\web run test
  }))
}
if (-not $SkipBuild) {
  $commands.Add((Invoke-MeasuredCommand -Name "web_production_build" -Command {
    npm --prefix .\apps\web run build
  }))
}

$git = Get-Command git -ErrorAction SilentlyContinue
$gitCommit = if ($git) { (& git rev-parse HEAD).Trim() } else { "unknown" }
$nodeVersion = (& node --version).Trim()
$cargoVersion = (& (Join-Path $env:CARGO_HOME "bin\cargo.exe") --version).Trim()
$webSourceFiles = @(
  Get-ChildItem -LiteralPath ".\apps\web" -Recurse -File |
    Where-Object {
      $_.FullName -notmatch "[\\/](node_modules|\.next|test-results|playwright-report)[\\/]" -and
      $_.Extension -in @(".ts", ".tsx", ".css")
    }
)
$webSourceLines = 0
foreach ($file in $webSourceFiles) {
  $webSourceLines += @(Get-Content -LiteralPath $file.FullName).Count
}

$record = [ordered]@{
  schema_version = 1
  measured_at = (Get-Date).ToUniversalTime().ToString("o")
  git_commit = $gitCommit
  environment = [ordered]@{
    os = [System.Environment]::OSVersion.VersionString
    node = $nodeVersion
    cargo = $cargoVersion
    samples = $Samples
  }
  commands = $commands
  artifacts = [ordered]@{
    next_build_bytes = Get-DirectorySizeBytes -Path ".\apps\web\.next"
    next_standalone_bytes = Get-DirectorySizeBytes -Path ".\apps\web\.next\standalone"
    next_static_bytes = Get-DirectorySizeBytes -Path ".\apps\web\.next\static"
    web_source_files = $webSourceFiles.Count
    web_source_lines = $webSourceLines
  }
  endpoints = @(
    Measure-HttpEndpoint -Name "api_health" -Uri "$($ApiBaseUrl.TrimEnd('/'))/health" -Count $Samples
    Measure-HttpEndpoint -Name "web_home" -Uri $WebBaseUrl -Count $Samples
  )
}

if (-not $OutputPath) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path $ProjectRoot ".tmp\performance-baseline-$timestamp.json"
}
elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath = Join-Path $ProjectRoot $OutputPath
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8

Write-Host ""
Write-Host "Baseline written to $OutputPath"
$record | ConvertTo-Json -Depth 8
