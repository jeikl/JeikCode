# Backward-compatible installer entrypoint.
# The authoritative implementation is scripts/install.ps1; keep this alias
# thin so verification behavior cannot drift between two download paths.
$ErrorActionPreference = "Stop"

$InvocationPath = $MyInvocation.MyCommand.Path
if ($InvocationPath) {
    $LocalInstaller = Join-Path (Split-Path -Parent $InvocationPath) "install.ps1"
    if (Test-Path -LiteralPath $LocalInstaller) {
        & $LocalInstaller
        exit $LASTEXITCODE
    }
}

$TempInstaller = Join-Path ([System.IO.Path]::GetTempPath()) ("jeikcode-install-" + [guid]::NewGuid().ToString("N") + ".ps1")
try {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1" -OutFile $TempInstaller -UseBasicParsing -TimeoutSec 15
    & $TempInstaller
    exit $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $TempInstaller -Force -ErrorAction SilentlyContinue
}
