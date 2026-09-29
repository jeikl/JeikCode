# JeikCode 兼容安装脚本 (Windows / PowerShell)
# 注：推荐使用官方标准安装脚本 scripts/install.ps1
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install-self.ps1 | iex"
#
# Env overrides:
#   $env:JEIKCODE_VERSION    release tag(默认从 latest.json 检测)
#   $env:JEIKCODE_PREFIX     安装目录(默认 $HOME\.local\bin)
#   $env:JEIKCODE_MANIFEST_URL / $env:JEIKCODE_DOWNLOAD_BASE  覆盖更新渠道(可选)
#
# 默认回退源已升级至 jeikl/JeikCode 官方 main 渠道。

$ErrorActionPreference = "Stop"

$ManifestUrl = if ($env:JEIKCODE_MANIFEST_URL) { $env:JEIKCODE_MANIFEST_URL.TrimEnd('/') } else { "https://github.com/jeikl/JeikCode/releases/latest/download/latest.json" }
if (-not $ManifestUrl.EndsWith('.json')) { $ManifestUrl = "$ManifestUrl/latest.json" }
$RepoBase     = if ($env:JEIKCODE_DOWNLOAD_BASE) { $env:JEIKCODE_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/jeikl/JeikCode/releases/download" }
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
    Write-Host "==> Detecting latest version ($ManifestUrl)"
    try {
        $manifest = Invoke-RestMethod -Uri $ManifestUrl -TimeoutSec 10
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

# --- check & sync config if ~/.jeikcode exists ---
$JeikcodeHome = if ($env:JEIKCODE_HOME) { $env:JEIKCODE_HOME } else { Join-Path $HOME ".jeikcode" }
if (Test-Path $JeikcodeHome) {
    Write-Host ""
    Write-Host "==> 检测到已有配置目录 ($JeikcodeHome)，正在检查内置配置更新..."
    try {
        & $Target __sync_config
    } catch {
        Write-Host "    (跳过交互式配置同步：$_)"
    }
}

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
Write-Host "==> 本 fork 已内置 local-dev 更新渠道; 想自动无感更新, 在 ~/.jeikcode/config.toml 加:"
Write-Host "    auto_update = true"
