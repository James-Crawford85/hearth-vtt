# Prints or sets Hearth's version in the two places it lives:
#   Cargo.toml                                ([workspace.package] version)
#   crates/hearth-desktop/tauri.conf.json     ("version")
#
#   powershell -File tools\set-version.ps1          -> prints the current version
#   powershell -File tools\set-version.ps1 0.2.0    -> sets it
#
# Files are written back as UTF-8 without a BOM, keeping their line endings.
param([string]$Version)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$cargoPath = Join-Path $root 'Cargo.toml'
$tauriPath = Join-Path $root 'crates\hearth-desktop\tauri.conf.json'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Find-Version([string]$text, [string]$pattern, [string]$file) {
    $m = [regex]::Match($text, $pattern)
    if (-not $m.Success) { throw "Couldn't find the version in $file" }
    return $m.Groups['v']
}

function Set-At([string]$text, $group, [string]$value) {
    return $text.Substring(0, $group.Index) + $value + $text.Substring($group.Index + $group.Length)
}

$cargo = [IO.File]::ReadAllText($cargoPath)
$tauri = [IO.File]::ReadAllText($tauriPath)
$cargoV = Find-Version $cargo '(?ms)^\[workspace\.package\]\s*$.*?^version\s*=\s*"(?<v>[^"]*)"' 'Cargo.toml'
$tauriV = Find-Version $tauri '"version"\s*:\s*"(?<v>[^"]*)"' 'tauri.conf.json'

if (-not $Version) {
    if ($cargoV.Value -ne $tauriV.Value) {
        Write-Warning "Versions differ: Cargo.toml has $($cargoV.Value), tauri.conf.json has $($tauriV.Value)"
    }
    Write-Output $cargoV.Value
    exit 0
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3 (got '$Version')" }

[IO.File]::WriteAllText($cargoPath, (Set-At $cargo $cargoV $Version), $utf8)
[IO.File]::WriteAllText($tauriPath, (Set-At $tauri $tauriV $Version), $utf8)
Write-Output "Version set to $Version"
