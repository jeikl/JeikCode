#!/bin/sh
# JeikCode installer — curl | sh
#
#   curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
#
# Env overrides:
#   JEIKCODE_VERSION   release tag to install (default: latest release asset latest.json)
#   JEIKCODE_PREFIX    install dir (absolute path; default: /usr/local/bin if writable,
#                        else ~/.local/bin). On HarmonyOS as non-root, default is ~/.local/bin.
#   JEIKCODE_MANIFEST_URL / JEIKCODE_DOWNLOAD_BASE  override update channel (optional)
#
# IMPORTANT: when changing install paths, the PATH-rc edit format, or filenames here,
# also update scripts/uninstall.sh AND
# crates/jeikcode-cli/src/uninstall/paths.rs.
set -eu

REPO_BASE="${JEIKCODE_DOWNLOAD_BASE:-https://github.com/jeikl/JeikCode/releases/download}"
REQUESTED_TAG=""
if [ -n "${JEIKCODE_VERSION:-}" ]; then
    case "$JEIKCODE_VERSION" in
        v*) REQUESTED_TAG="$JEIKCODE_VERSION" ;;
        *)  REQUESTED_TAG="v$JEIKCODE_VERSION" ;;
    esac
fi
if [ -n "${JEIKCODE_MANIFEST_URL:-}" ]; then
    MANIFEST_URL="${JEIKCODE_MANIFEST_URL}"
    case "$MANIFEST_URL" in
        *.json) ;;
        *) MANIFEST_URL="${MANIFEST_URL%/}/latest.json" ;;
    esac
elif [ -n "$REQUESTED_TAG" ]; then
    MANIFEST_URL="https://github.com/jeikl/JeikCode/releases/download/${REQUESTED_TAG}/latest.json"
else
    MANIFEST_URL="https://github.com/jeikl/JeikCode/releases/latest/download/latest.json"
fi

# --- detect platform ---
uname_s=$(uname -s)
uname_m=$(uname -m)
ext=""  # binary filename suffix; ".exe" on Windows shells (set below)

case "$uname_s" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    HarmonyOS) os="ohos" ;;
    MSYS*|MINGW*|CYGWIN*) os="windows"; ext=".exe" ;;
    *) echo "Unsupported OS: $uname_s (Windows users: download the zip from the release page)"; exit 1 ;;
esac

case "$uname_m" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64"   ;;
    *) echo "Unsupported arch: $uname_m"; exit 1 ;;
esac

# --- pick install dir ---
if [ -n "${JEIKCODE_PREFIX:-}" ]; then
    PREFIX="$JEIKCODE_PREFIX"
elif [ "$os" = "ohos" ] || [ "$os" = "windows" ]; then
    PREFIX="$HOME/.local/bin"
elif [ -w /usr/local/bin ] 2>/dev/null; then
    PREFIX="/usr/local/bin"
elif [ "$(id -u)" -eq 0 ]; then
    PREFIX="/usr/local/bin"
else
    PREFIX="$HOME/.local/bin"
fi
mkdir -p "$PREFIX"

# --- download tools ---
if command -v curl >/dev/null 2>&1; then
    _fetch="curl -sL --connect-timeout 5 --max-time 10"
    _down="curl -fL --progress-bar -o"
elif command -v wget >/dev/null 2>&1; then
    _fetch="wget -qO- --timeout=10 --tries=1"
    _down="wget --show-progress -O"
else
    echo "Error: need curl or wget." >&2
    exit 1
fi

# --- fetch and validate release manifest ---
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
MANIFEST_FILE="$TMP/latest.json"
echo "==> Reading release manifest (${MANIFEST_URL})"
if ! $_down "$MANIFEST_FILE" "$MANIFEST_URL"; then
    echo "Error: could not download release manifest; refusing an unverified install." >&2
    exit 1
fi

MANIFEST_COMPACT=$(tr -d '\r\n' < "$MANIFEST_FILE")
VERSION=$(printf '%s' "$MANIFEST_COMPACT" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$VERSION" ] || {
    echo "Error: release manifest is missing a version." >&2
    exit 1
}
case "$VERSION" in
    v*) MANIFEST_TAG="$VERSION" ;;
    *)  MANIFEST_TAG="v$VERSION" ;;
esac
if [ -n "$REQUESTED_TAG" ] && [ "$MANIFEST_TAG" != "$REQUESTED_TAG" ]; then
    echo "Error: requested $REQUESTED_TAG but manifest reports $MANIFEST_TAG." >&2
    exit 1
fi

TARGET_KEY="${os}-${arch}"
TARGET_JSON=$(printf '%s' "$MANIFEST_COMPACT" | sed -n "s/.*\"${TARGET_KEY}\"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p")
[ -n "$TARGET_JSON" ] || {
    echo "Error: release manifest has no binary entry for $TARGET_KEY." >&2
    exit 1
}
EXPECTED_SHA=$(printf '%s' "$TARGET_JSON" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9A-Fa-f]*\)".*/\1/p')
EXPECTED_SIZE=$(printf '%s' "$TARGET_JSON" | sed -n 's/.*"size"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
printf '%s\n' "$EXPECTED_SHA" | grep -Eq '^[0-9A-Fa-f]{64}$' || {
    echo "Error: release manifest has an invalid SHA256 for $TARGET_KEY." >&2
    exit 1
}
printf '%s\n' "$EXPECTED_SIZE" | grep -Eq '^[1-9][0-9]*$' || {
    echo "Error: release manifest has an invalid size for $TARGET_KEY." >&2
    exit 1
}

# --- download ---
DEST="$TMP/jeikcode${ext}"

# Prefer jeikcode-* asset with v-prefix (e.g. v7.0.0); fall back to non-v tag (legacy).
case "$VERSION" in
    v*) PRIMARY_TAG="$VERSION"; SECONDARY_TAG="${VERSION#v}" ;;
    *)  PRIMARY_TAG="v$VERSION"; SECONDARY_TAG="$VERSION" ;;
esac

BIN_NAME="jeikcode-${PRIMARY_TAG}-${os}-${arch}${ext}"
URL="${REPO_BASE}/${PRIMARY_TAG}/${BIN_NAME}"

echo "==> Downloading $BIN_NAME"
echo "    from $URL"
if ! $_down "$DEST" "$URL"; then
    ALT_NAME="jeikcode-${SECONDARY_TAG}-${os}-${arch}${ext}"
    ALT_URL="${REPO_BASE}/${SECONDARY_TAG}/${ALT_NAME}"
    echo "==> Retrying with $ALT_NAME"
    echo "    from $ALT_URL"
    $_down "$DEST" "$ALT_URL"
fi

# Sanity check: must be a real binary, not an HTML 404 page
if head -c 4 "$DEST" | grep -q "<" 2>/dev/null; then
    echo "Error: download looks like an HTML page, not a binary."
    echo "       The release may not exist for your platform, or the URL is wrong."
    echo "       URL: $URL"
    exit 1
fi

ACTUAL_SIZE=$(wc -c < "$DEST" | tr -d '[:space:]')
if [ "$ACTUAL_SIZE" != "$EXPECTED_SIZE" ]; then
    echo "Error: downloaded binary size mismatch (expected $EXPECTED_SIZE, got $ACTUAL_SIZE)." >&2
    exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA=$(sha256sum "$DEST" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA=$(shasum -a 256 "$DEST" | awk '{print $1}')
elif command -v openssl >/dev/null 2>&1; then
    ACTUAL_SHA=$(openssl dgst -sha256 "$DEST" | awk '{print $NF}')
else
    echo "Error: need sha256sum, shasum, or openssl to verify the download." >&2
    exit 1
fi
if [ "$(printf '%s' "$ACTUAL_SHA" | tr 'A-F' 'a-f')" != "$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')" ]; then
    echo "Error: downloaded binary SHA256 mismatch; refusing installation." >&2
    exit 1
fi
echo "==> Verified SHA256 and size for $TARGET_KEY"

chmod +x "$DEST"

# --- install ---
TARGET="$PREFIX/jeikcode${ext}"
if [ "$os" = "windows" ]; then
    echo "==> Installing to $TARGET"
    if ! mv "$DEST" "$TARGET"; then
        echo "Error: could not write $TARGET." >&2
        echo "       If jeikcode is already running, close it and re-run this installer." >&2
        exit 1
    fi
elif [ -e "$TARGET" ] && [ ! -w "$TARGET" ]; then
    echo "==> Installing to $TARGET (sudo required)"
    sudo mv "$DEST" "$TARGET"
elif [ ! -w "$PREFIX" ]; then
    echo "==> Installing to $TARGET (sudo required)"
    sudo mv "$DEST" "$TARGET"
else
    echo "==> Installing to $TARGET"
    mv "$DEST" "$TARGET"
fi

ALIAS="$PREFIX/atomcode${ext}"
if [ "$os" = "linux" ] || [ "$os" = "darwin" ] || [ "$os" = "ohos" ]; then
    ln -sf "$TARGET" "$ALIAS" 2>/dev/null || cp -f --remove-destination "$TARGET" "$ALIAS" 2>/dev/null || sudo ln -sf "$TARGET" "$ALIAS" 2>/dev/null || sudo cp -f --remove-destination "$TARGET" "$ALIAS" 2>/dev/null || true
fi

# --- done ---
echo ""
echo "Installed: $TARGET"
"$TARGET" --version 2>/dev/null || true

# --- check & sync config if ~/.jeikcode exists ---
JEIKCODE_HOME="${JEIKCODE_HOME:-$HOME/.jeikcode}"
if [ -d "$JEIKCODE_HOME" ]; then
    echo ""
    echo "==> 检测到已有配置目录 ($JEIKCODE_HOME)，正在检查内置配置更新..."
    if [ -t 0 ]; then
        "$TARGET" __sync_config || true
    elif [ -e /dev/tty ] && [ -r /dev/tty ]; then
        "$TARGET" __sync_config < /dev/tty || true
    else
        echo "    (非交互终端环境，将在首次启动 WebUI 或桌面端时提示配置文件更新)"
    fi
fi

if [ "$os" = "windows" ]; then
    echo ""
    echo "Note: installed for this Unix shell (MSYS/MinGW/Git-Bash/Cygwin)."
    echo "      For a system-wide Windows install (cmd / PowerShell PATH), use instead:"
    echo "      powershell -c \"irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex\""
fi

case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *)
        LINE="export PATH=\"$PREFIX:\$PATH\""
        RC=""
        if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
            RC="$HOME/.zshrc"
        elif [ -n "${BASH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "bash" ]; then
            RC="$HOME/.bashrc"
        fi

        if [ -n "$RC" ]; then
            if [ -f "$RC" ] && grep -qxF "$LINE" "$RC" 2>/dev/null; then
                :
            else
                echo "" >> "$RC"
                echo "# Added by JeikCode installer" >> "$RC"
                echo "$LINE" >> "$RC"
                echo ""
                echo "Added $PREFIX to PATH in $RC"
            fi
            echo ""
            echo "To start using jeikcode right now, run:"
            echo ""
            echo "    source $RC"
            echo ""
        else
            echo ""
            echo "Note: $PREFIX is not in your PATH. Add this line to your shell rc:"
            echo "    $LINE"
        fi
        ;;
esac

echo ""
echo "==> JeikCode uses the official release update channel. To enable auto-update, add to ~/.jeikcode/config.toml:"
echo "    auto_update = true"
