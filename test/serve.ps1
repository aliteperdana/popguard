<#
  Serves test/fixtures over http://localhost:8123/ so the content scripts have a
  real http origin. Opening the fixtures as file:// will NOT work: the extension
  has no file access by default, and MAIN-world scripts need a normal origin.

  Usage:
      powershell -ExecutionPolicy Bypass -File test/serve.ps1
      powershell -ExecutionPolicy Bypass -File test/serve.ps1 -Port 9000
#>
[CmdletBinding()]
param(
  [int]$Port = 8123
)

$ErrorActionPreference = 'Stop'

$root = Join-Path $PSScriptRoot 'fixtures'
if (-not (Test-Path $root)) {
  throw "Fixture directory not found: $root"
}

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host "Serving $root"
Write-Host "  http://localhost:$Port/"
Write-Host 'Tekan Ctrl+C untuk berhenti.'

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $requestPath = $context.Request.Url.AbsolutePath.TrimStart('/')

    if ([string]::IsNullOrWhiteSpace($requestPath)) {
      $requestPath = 'index.html'
    }

    $resolved = Join-Path $root $requestPath
    $resolved = [System.IO.Path]::GetFullPath($resolved)

    # Refuse anything that escapes the fixture directory.
    if (-not $resolved.StartsWith([System.IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase)) {
      $context.Response.StatusCode = 403
      $context.Response.Close()
      continue
    }

    if (Test-Path $resolved -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($resolved)
      $extension = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
      $context.Response.ContentType = if ($types.ContainsKey($extension)) { $types[$extension] } else { 'application/octet-stream' }
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    else {
      $context.Response.StatusCode = 404
      $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $requestPath")
      $context.Response.ContentLength64 = $body.Length
      $context.Response.OutputStream.Write($body, 0, $body.Length)
    }

    $context.Response.Close()
  }
}
finally {
  $listener.Stop()
  $listener.Close()
}
