param(
  [ValidateSet("start", "stop", "status", "psql", "env")]
  [string]$Action = "start"
)

$ErrorActionPreference = "Stop"

$SourceProjectRoot = Split-Path -Parent $PSScriptRoot

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
  $markerFile = Join-Path $runtimeRoot "postgres-subst-drive.txt"
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

  if (Test-Path $markerFile) {
    $markedDrive = (Get-Content -LiteralPath $markerFile -TotalCount 1).Trim()
    if ($markedDrive -match "^[A-Z]:$") {
      $markedRoot = "$markedDrive\"
      if ((Get-PSDrive -Name $markedDrive.TrimEnd(":") -ErrorAction SilentlyContinue) -and
          (Test-Path (Join-Path $markedRoot "scripts\postgres.ps1"))) {
        Write-Host "[postgres] using ASCII workspace path $markedRoot -> $OriginalRoot"
        return $markedRoot
      }
    }
  }

  $subst = Join-Path $env:SystemRoot "System32\subst.exe"
  foreach ($letter in @("M", "N", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z")) {
    if (Get-PSDrive -Name $letter -ErrorAction SilentlyContinue) {
      continue
    }

    $drive = "${letter}:"
    & $subst $drive $OriginalRoot
    if ($LASTEXITCODE -eq 0) {
      Set-Content -LiteralPath $markerFile -Value $drive -NoNewline
      $mappedRoot = "$drive\"
      Write-Host "[postgres] using ASCII workspace path $mappedRoot -> $OriginalRoot"
      return $mappedRoot
    }
  }

  throw "Could not create an ASCII subst drive for PostgreSQL. Please free one drive letter from M: to Z:."
}

$ProjectRoot = Get-RuntimeProjectRoot $SourceProjectRoot
$PostgresRoot = Join-Path $ProjectRoot ".tools\postgresql-17.10\pgsql"
$PostgresBin = Join-Path $PostgresRoot "bin"
$DataDir = Join-Path $ProjectRoot ".data\postgres"
$RuntimeDir = Join-Path $ProjectRoot ".runtime\postgres"
$LogFile = Join-Path $RuntimeDir "postgres.log"
$TempRoot = Join-Path $ProjectRoot ".cache\tmp"

$Port = if ($env:PGPORT) { $env:PGPORT } else { "5432" }
$HostName = if ($env:PGHOST) { $env:PGHOST } else { "127.0.0.1" }
$AdminUser = "postgres"
$AppUser = "manga"
$AppPassword = "manga"
$AppDatabase = "manga"

$PgCtl = Join-Path $PostgresBin "pg_ctl.exe"
$InitDb = Join-Path $PostgresBin "initdb.exe"
$Psql = Join-Path $PostgresBin "psql.exe"
$PgIsReady = Join-Path $PostgresBin "pg_isready.exe"
$CreateDb = Join-Path $PostgresBin "createdb.exe"

function Assert-PostgresTools {
  foreach ($tool in @($PgCtl, $InitDb, $Psql, $PgIsReady, $CreateDb)) {
    if (-not (Test-Path $tool)) {
      throw "PostgreSQL tool not found: $tool"
    }
  }
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

function Test-PostgresRunning {
  & $PgCtl status "-D" $DataDir *> $null
  if ($LASTEXITCODE -eq 0) {
    return $true
  }

  & $PgIsReady "-h" $HostName "-p" $Port "-U" $AdminUser "-d" "postgres" "-q" *> $null
  return $LASTEXITCODE -eq 0
}

function Initialize-PostgresData {
  if (Test-Path (Join-Path $DataDir "PG_VERSION")) {
    return
  }

  New-Item -ItemType Directory -Force -Path $DataDir, $RuntimeDir, $TempRoot | Out-Null
  $env:TEMP = $TempRoot
  $env:TMP = $TempRoot

  Write-Host "[postgres] initdb -> $DataDir"
  Invoke-Native $InitDb "-D" $DataDir "-U" $AdminUser "--encoding=UTF8" "--locale=C" "--auth=trust"
}

function Start-Postgres {
  Initialize-PostgresData
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

  if (Test-PostgresRunning) {
    Write-Host "[postgres] already running"
    return
  }

  Write-Host "[postgres] start on ${HostName}:${Port}"
  Invoke-Native $PgCtl "start" "-D" $DataDir "-l" $LogFile "-o" "-p $Port -h $HostName"
}

function Ensure-ApplicationDatabase {
  $roleSql = @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$AppUser') THEN
    CREATE ROLE $AppUser LOGIN PASSWORD '$AppPassword';
  END IF;
END
`$`$;
"@

  Write-Host "[postgres] ensure role/database: $AppUser / $AppDatabase"
  Invoke-Native $Psql "-h" $HostName "-p" $Port "-U" $AdminUser "-d" "postgres" "-v" "ON_ERROR_STOP=1" "-c" $roleSql

  $databaseExists = & $Psql "-h" $HostName "-p" $Port "-U" $AdminUser "-d" "postgres" "-tAc" "SELECT 1 FROM pg_database WHERE datname = '$AppDatabase'"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check whether database exists: $AppDatabase"
  }

  if (($databaseExists -join "`n").Trim() -ne "1") {
    Invoke-Native $CreateDb "-h" $HostName "-p" $Port "-U" $AdminUser "-O" $AppUser $AppDatabase
  }
}

function Stop-Postgres {
  if (-not (Test-Path (Join-Path $DataDir "PG_VERSION"))) {
    Write-Host "[postgres] data directory does not exist"
    return
  }

  if (-not (Test-PostgresRunning)) {
    Write-Host "[postgres] already stopped"
    return
  }

  Write-Host "[postgres] stop"
  Invoke-Native $PgCtl "stop" "-D" $DataDir "-m" "fast"
}

function Show-Status {
  if (-not (Test-Path (Join-Path $DataDir "PG_VERSION"))) {
    Write-Host "[postgres] not initialized"
    return
  }

  $statusOutput = & $PgCtl status "-D" $DataDir 2>&1
  if ($LASTEXITCODE -eq 0) {
    $statusOutput
  } else {
    & $PgIsReady "-h" $HostName "-p" $Port "-U" $AppUser "-d" $AppDatabase "-q"
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[postgres] accepting connections; pg_ctl cannot inspect this process from the current shell"
    } else {
      Write-Host "[postgres] pg_ctl status: $($statusOutput -join ' ')"
    }
  }
  & $PgIsReady "-h" $HostName "-p" $Port "-U" $AppUser "-d" $AppDatabase
}

function Show-Env {
  Write-Host "TASK_REPOSITORY=postgres"
  Write-Host "API_AUTO_MIGRATE=true"
  Write-Host "DATABASE_URL=postgres://${AppUser}:${AppPassword}@${HostName}:${Port}/${AppDatabase}?sslmode=disable"
}

Assert-PostgresTools

switch ($Action) {
  "start" {
    Start-Postgres
    Ensure-ApplicationDatabase
    Show-Env
  }
  "stop" {
    Stop-Postgres
  }
  "status" {
    Show-Status
  }
  "psql" {
    Start-Postgres
    Ensure-ApplicationDatabase
    Invoke-Native $Psql "-h" $HostName "-p" $Port "-U" $AppUser "-d" $AppDatabase
  }
  "env" {
    Show-Env
  }
}
