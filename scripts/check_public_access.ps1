$ErrorActionPreference = "Stop"

$scriptPaths = @(
  (Join-Path $PSScriptRoot "public-api.ps1"),
  (Join-Path $PSScriptRoot "public-web.ps1"),
  (Join-Path $PSScriptRoot "public-tunnel.ps1"),
  (Join-Path $PSScriptRoot "public-access.ps1")
)

foreach ($scriptPath in $scriptPaths) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    throw "PowerShell syntax failed for $($scriptPath): $($errors[0].Message)"
  }
}

function Require-Literal {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text,
    [Parameter(Mandatory = $true)]
    [string]$Literal,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if ($Text.IndexOf($Literal, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing public access contract: $Label"
  }
}

$api = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "public-api.ps1"))
$access = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "public-access.ps1"))
$tunnel = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "public-tunnel.ps1"))

Require-Literal $api 'Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health"' "API health check"
Require-Literal $api '$env:DEV_API_BIND_HOST = "127.0.0.1"' "loopback API bind"
Require-Literal $api '-WindowStyle Hidden' "hidden managed API"
Require-Literal $api 'Get-CimInstance Win32_Process' "managed process identity verification"
Require-Literal $access '$publicApiScript = Join-Path $PSScriptRoot "public-api.ps1"' "public API registration"
Require-Literal $access '& $publicApiScript -Status' "public API status"
Require-Literal $access '& $publicApiScript -Stop' "public API stop"
Require-Literal $tunnel '[string]$Protocol = "http2"' "HTTP/2 default"
Require-Literal $tunnel 'function Test-PublicUrlReady' "public URL health check"
Require-Literal $tunnel 'Replacing unhealthy Quick Tunnel' "unhealthy tunnel replacement"
Require-Literal $tunnel '"--protocol", $Protocol' "cloudflared protocol argument"

$apiStart = $access.IndexOf('& $publicApiScript -ApiPort $localApiPort', [System.StringComparison]::Ordinal)
$webStart = $access.IndexOf('& $publicWebScript @webParameters', [System.StringComparison]::Ordinal)
$tunnelStart = $access.IndexOf('& $tunnelScript -WebPort $WebPort', [System.StringComparison]::Ordinal)
if ($apiStart -lt 0 -or $webStart -lt 0 -or $tunnelStart -lt 0 -or -not ($apiStart -lt $webStart -and $webStart -lt $tunnelStart)) {
  throw "Public services must start in API -> web -> tunnel order."
}

$tunnelStop = $access.IndexOf('& $tunnelScript -Stop', [System.StringComparison]::Ordinal)
$webStop = $access.IndexOf('& $publicWebScript -Stop', [System.StringComparison]::Ordinal)
$apiStop = $access.IndexOf('& $publicApiScript -Stop', [System.StringComparison]::Ordinal)
if ($tunnelStop -lt 0 -or $webStop -lt 0 -or $apiStop -lt 0 -or -not ($tunnelStop -lt $webStop -and $webStop -lt $apiStop)) {
  throw "Public services must stop in tunnel -> web -> API order."
}

Write-Output "public access lifecycle check passed"
