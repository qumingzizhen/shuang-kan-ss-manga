$SourceProjectRoot = Split-Path -Parent $PSScriptRoot
$LegacyBridgePython = Join-Path (Split-Path -Parent $SourceProjectRoot) ".venv\Scripts\python.exe"

# Resolve the bridge interpreter before switching to an ASCII subst drive. A
# parent-directory virtualenv cannot be reached through the mapped drive root.
if (-not $env:MANGA_BRIDGE_PYTHON -and (Test-Path -LiteralPath $LegacyBridgePython)) {
  $env:MANGA_BRIDGE_PYTHON = $LegacyBridgePython
}

function Test-AsciiString {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  foreach ($character in $Value.ToCharArray()) {
    if ([int][char]$character -gt 127) {
      return $false
    }
  }
  return $true
}

function Get-RuntimeProjectRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$OriginalRoot
  )

  if (Test-AsciiString $OriginalRoot) {
    return $OriginalRoot
  }

  $runtimeRoot = Join-Path $OriginalRoot ".runtime"
  $workspaceMarker = Join-Path $runtimeRoot "workspace-subst-drive.txt"
  $postgresMarker = Join-Path $runtimeRoot "postgres-subst-drive.txt"
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

  foreach ($markerFile in @($workspaceMarker, $postgresMarker)) {
    if (-not (Test-Path $markerFile)) {
      continue
    }

    $markedDrive = (Get-Content -LiteralPath $markerFile -TotalCount 1).Trim()
    if ($markedDrive -match "^[A-Z]:$") {
      $driveName = $markedDrive.TrimEnd(":")
      $markedRoot = "$markedDrive\"
      if ((Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue) -and
          (Test-Path (Join-Path $markedRoot "scripts\dev-env.ps1"))) {
        Write-Host "Runtime project root: $markedRoot -> $OriginalRoot"
        return $markedRoot
      }
    }
  }

  $subst = Join-Path $env:SystemRoot "System32\subst.exe"
  foreach ($letter in @("M", "N", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z")) {
    $drive = "${letter}:"
    $driveName = $letter
    $driveRoot = "$drive\"

    if (Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue) {
      if (Test-Path (Join-Path $driveRoot "scripts\dev-env.ps1")) {
        Set-Content -LiteralPath $workspaceMarker -Value $drive -NoNewline
        Write-Host "Runtime project root: $driveRoot -> $OriginalRoot"
        return $driveRoot
      }
      continue
    }

    & $subst $drive $OriginalRoot
    if ($LASTEXITCODE -eq 0) {
      Set-Content -LiteralPath $workspaceMarker -Value $drive -NoNewline
      Write-Host "Runtime project root: $driveRoot -> $OriginalRoot"
      return $driveRoot
    }
  }

  throw "Could not create an ASCII subst drive. Please free one drive letter from M: to Z:."
}

$ProjectRoot = Get-RuntimeProjectRoot $SourceProjectRoot
$CacheRoot = Join-Path $ProjectRoot ".cache"
$TempRoot = Join-Path $CacheRoot "tmp"
$PythonPackages = Join-Path $CacheRoot "python"

$env:NPM_CONFIG_CACHE = Join-Path $CacheRoot "npm"
$env:CARGO_HOME = Join-Path $CacheRoot "cargo"
$env:RUSTUP_HOME = Join-Path $CacheRoot "rustup"
$env:PNPM_HOME = Join-Path $CacheRoot "pnpm"
$env:YARN_CACHE_FOLDER = Join-Path $CacheRoot "yarn"
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:CARGO_TARGET_DIR = Join-Path $ProjectRoot "target"
$RustGnuBin = Join-Path $CacheRoot "rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"
$RustGnuSelfContainedBin = Join-Path $CacheRoot "rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained"
$PostgresBin = Join-Path $ProjectRoot ".tools\postgresql-17.10\pgsql\bin"
$CargoBin = Join-Path $env:CARGO_HOME "bin"

New-Item -ItemType Directory -Force `
  -Path $env:NPM_CONFIG_CACHE, $env:CARGO_HOME, $env:RUSTUP_HOME, $env:PNPM_HOME, $env:YARN_CACHE_FOLDER, $TempRoot, $PythonPackages `
  | Out-Null

$ExistingPythonPath = @(
  [string]$env:PYTHONPATH -split ";" |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and $_ -ne $PythonPackages }
)
$env:PYTHONPATH = (@($PythonPackages) + $ExistingPythonPath) -join ";"

if (Test-Path $PostgresBin) {
  $env:Path = "$PostgresBin;$env:Path"
}

if (Test-Path $CargoBin) {
  $env:Path = "$CargoBin;$env:Path"
}

if (Test-Path $RustGnuBin) {
  $env:Path = "$RustGnuBin;$env:Path"
}

if (Test-Path $RustGnuSelfContainedBin) {
  $env:Path = "$RustGnuSelfContainedBin;$env:Path"
}

Write-Host "Project cache root: $CacheRoot"
Write-Host "NPM_CONFIG_CACHE=$env:NPM_CONFIG_CACHE"
Write-Host "CARGO_HOME=$env:CARGO_HOME"
Write-Host "RUSTUP_HOME=$env:RUSTUP_HOME"
Write-Host "CARGO_TARGET_DIR=$env:CARGO_TARGET_DIR"
Write-Host "TEMP=$env:TEMP"
Write-Host "PYTHONPATH=$env:PYTHONPATH"
Write-Host "MANGA_BRIDGE_PYTHON=$env:MANGA_BRIDGE_PYTHON"
Write-Host "PostgreSQL bin=$PostgresBin"
Write-Host "Rust GNU bin=$RustGnuBin"
