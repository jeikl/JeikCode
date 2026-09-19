# JeikCode installer for Windows — PowerShell
#
#   irm https://raw.githubusercontent.com/JeikCode/JeikCode/main/scripts/install.ps1 | iex
#
# Env overrides:
#   $env:JEIKCODE_VERSION    release tag (default: latest from fork latest.json)
#   $env:JEIKCODE_PREFIX     install dir (default: $HOME\.local\bin)
#   $env:JEIKCODE_MANIFEST_URL / $env:JEIKCODE_DOWNLOAD_BASE  override update channel (optional)

$ErrorActionPreference = "Stop"

$ManifestBase = if ($env:JEIKCODE_MANIFEST_URL) { $env:JEIKCODE_MANIFEST_URL.TrimEnd('/') } else { "https://raw.githubusercontent.com/JeikCode/JeikCode/main" }
$RepoBase     = if ($env:JEIKCODE_DOWNLOAD_BASE) { $env:JEIKCODE_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/JeikCode/JeikCode/releases/download" }
$DefaultVersion = "v7.0.0"

# --- detect platform ---
$os = "windows"
$RealArch = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
} else {
    $env:PROCESSOR_ARCHITECTURE
}
switch ($RealArch) {
    "AMD64" { $arch = "x64" }
    "ARM64" { $arch = "arm64" }
    default {
        Write-Host "Unsupported architecture: $RealArch (supported: AMD64, ARM64)" -ForegroundColor Red
        exit 1
    }
}
$ext = ".exe"

# --- install dir ---
$Prefix = if ($env:JEIKCODE_PREFIX) { $env:JEIKCODE_PREFIX } else { Join-Path $HOME ".local\bin" }
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

# --- resolve version ---
if ($env:JEIKCODE_VERSION) {
    $Version = $env:JEIKCODE_VERSION
} else {
    Write-Host "==> Detecting latest version ($ManifestBase/latest.json)"
    try {
        $manifest = Invoke-RestMethod -Uri "$ManifestBase/latest.json" -TimeoutSec 10
        $Version = $manifest.version
    } catch {
        $Version = $DefaultVersion
    }
}

# --- download ---
$TagWithV = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
$TagWithoutV = $Version.TrimStart("v")

$PrimaryTag = $TagWithV
$SecondaryTag = $TagWithoutV

$BinName = "jeikcode-${PrimaryTag}-${os}-${arch}${ext}"
$Url = "$RepoBase/$PrimaryTag/$BinName"
$Dest = Join-Path $env:TEMP $BinName

Write-Host "==> Downloading $BinName"
Write-Host "    from $Url"
try {
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
} catch {
    $AltName = "jeikcode-${SecondaryTag}-${os}-${arch}${ext}"
    $AltUrl = "$RepoBase/$SecondaryTag/$AltName"
    Write-Host "==> Retrying with $AltName"
    Write-Host "    from $AltUrl"
    Invoke-WebRequest -Uri $AltUrl -OutFile $Dest -UseBasicParsing
}

# Sanity check: not an HTML 404 page
$head = [System.IO.File]::ReadAllBytes($Dest)[0..3]
$isHtml = ($head -contains 0x3C)  # '<'
if ($isHtml) {
    Write-Error "Download looks like an HTML page, not a binary. URL: $Url"
    exit 1
}

# --- install ---
$Target = Join-Path $Prefix "jeikcode$ext"
Write-Host "==> Installing to $Target"
try {
    Move-Item -Force $Dest $Target -ErrorAction Stop
} catch {
    Write-Host "Error: could not write $Target." -ForegroundColor Red
    Write-Host "       If jeikcode is already running, close it and re-run this installer." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Installed: $Target"
& $Target --version 2>$null

# --- PATH ---
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$Prefix*") {
    [Environment]::SetEnvironmentVariable("Path", "$Prefix;$currentPath", "User")
    Write-Host "Added $Prefix to user PATH (new shells will pick it up)."
} else {
    Write-Host "$Prefix already on user PATH."
}

# Update current session PATH so jeikcode can be used immediately
if ($env:Path -notlike "*$Prefix*") {
    $env:Path = "$Prefix;$env:Path"
}

Write-Host ""
Write-Host "==> JeikCode uses the local-dev update channel. To enable auto-update, add to ~/.jeikcode/config.toml:"
Write-Host "    auto_update = true"
