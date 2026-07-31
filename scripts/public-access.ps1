[CmdletBinding(DefaultParameterSetName = "Start")]
param(
  [Parameter(ParameterSetName = "Start")]
  [ValidateRange(1, 65535)]
  [int]$WebPort = 3100,

  [Parameter(ParameterSetName = "Start")]
  [ValidatePattern("^https?://")]
  [string]$BackendApiUrl = "http://127.0.0.1:8080",

  [Parameter(ParameterSetName = "Start")]
  [switch]$SkipBuild,

  [string]$CloudflaredPath = "E:\Programs\Cloudflared\cloudflared.exe",

  [Parameter(ParameterSetName = "Stop", Mandatory = $true)]
  [switch]$Stop,

  [Parameter(ParameterSetName = "Status", Mandatory = $true)]
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$publicWebScript = Join-Path $PSScriptRoot "public-web.ps1"
$tunnelScript = Join-Path $PSScriptRoot "public-tunnel.ps1"

if ($Status) {
  Write-Host "[public web]"
  & $publicWebScript -Status
  Write-Host ""
  Write-Host "[quick tunnel]"
  & $tunnelScript -Status -CloudflaredPath $CloudflaredPath
  return
}

if ($Stop) {
  & $tunnelScript -Stop -CloudflaredPath $CloudflaredPath
  & $publicWebScript -Stop
  Write-Host "Public access stopped."
  return
}

$webParameters = @{
  WebPort = $WebPort
  BackendApiUrl = $BackendApiUrl
}
if ($SkipBuild) {
  $webParameters.SkipBuild = $true
}

& $publicWebScript @webParameters
& $tunnelScript -WebPort $WebPort -CloudflaredPath $CloudflaredPath

Write-Host ""
Write-Host "Public access is ready."
Write-Host "Check it with: .\scripts\public-access.ps1 -Status"
Write-Host "Stop it with:  .\scripts\public-access.ps1 -Stop"
