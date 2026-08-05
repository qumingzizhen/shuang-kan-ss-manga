$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "`n[perf] Reader DOM benchmark (800-page fixture, production build, budgets enforced)"
node .\scripts\benchmark_reader_dom.mjs --budget
if ($LASTEXITCODE -ne 0) {
  throw "Reader benchmark failed or violated its performance budget"
}

Write-Host "[perf] Passed. Record the latest numbers in docs\性能基线台账-2026-08-05.md before/after each optimization."
