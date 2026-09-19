# JeikCode Self — fork 版一键安装(Windows / PowerShell)
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/jeikl/jeikcode/local-dev/scripts/install-self.ps1 | iex"
#
# Env overrides:
#   $env:JEIKCODE_VERSION    release tag(默认从 fork latest.json 检测)
#   $env:JEIKCODE_PREFIX     安装目录(默认 $HOME\.local\bin)
#   $env:JEIKCODE_MANIFEST_URL / $env:JEIKCODE_DOWNLOAD_BASE  覆盖更新渠道(可选)
#
# 与官方 install.ps1 结构一致,仅下载源指向 fork 的 local-dev 渠道。

$ErrorActionPreference = "Stop"

$ManifestBase = if ($env:JEIKCODE_MANIFEST_URL) { $env:JEIKCODE_MANIFEST_URL.TrimEnd('/') } else { "https://raw.githubusercontent.com/jeikl/jeikcode/local-dev" }
$RepoBase     = if ($env:JEIKCODE_DOWNLOAD_BASE) { $env:JEIKCODE_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/jeikl/jeikcode/releases/download" }
$DefaultVersion = "v0.0.0-dev.1"

# --- detect platform ---
$os = "windows"
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86_64" }
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

Write-Host ""
Write-Host "==> 本 fork 已内置 local-dev 更新渠道; 想自动无感更新, 在 ~/.jeikcode/config.toml 加:"
Write-Host "    auto_update = true"
