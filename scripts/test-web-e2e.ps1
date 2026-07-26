$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
. (Join-Path $ProjectRoot "scripts/dev-env.ps1")

$WebRoot = Join-Path $ProjectRoot "apps/web"
Push-Location $WebRoot
try {
  & npm exec -- playwright test
  if ($LASTEXITCODE -ne 0) {
    throw "Playwright browser tests failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}
