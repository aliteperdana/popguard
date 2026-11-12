<#
  Packages the extension for a GitHub release.

  The archive contains only what the browser needs: manifest.json, icons/ and
  src/. Development files (test/, docs) are deliberately excluded.

  Usage:
      powershell -ExecutionPolicy Bypass -File release.ps1
      powershell -ExecutionPolicy Bypass -File release.ps1 -OutDir out
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found in $root"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw 'manifest.json has no version field'
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "popguard-$version"
if (Test-Path $staging) {
  Remove-Item -Recurse -Force $staging
}
New-Item -ItemType Directory -Force -Path $staging | Out-Null

foreach ($item in @('manifest.json', 'icons', 'src')) {
  Copy-Item -LiteralPath (Join-Path $root $item) -Destination $staging -Recurse
}

# logo.png is the source the icons were generated from; the browser never loads
# it, and it is 90 KB of the package.
$sourceLogo = Join-Path $staging 'icons\logo.png'
if (Test-Path $sourceLogo) {
  Remove-Item -Force $sourceLogo
}

# manifest.json must sit at the top of the archive, otherwise "Load unpacked"
# after extraction points at the wrong folder.
$zipPath = Join-Path $root (Join-Path $OutDir "popguard-$version.zip")
New-Item -ItemType Directory -Force -Path (Join-Path $root $OutDir) | Out-Null
if (Test-Path $zipPath) {
  Remove-Item -Force $zipPath
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $staging

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host "Built $zipPath ($size KB) for version $version"
Write-Host 'Contents:'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead($zipPath).Entries |
  ForEach-Object { Write-Host ("  {0,-46} {1,8} B" -f $_.FullName, $_.Length) }
Write-Host ''
Write-Host "Next: git tag v$version && git push --tags"
