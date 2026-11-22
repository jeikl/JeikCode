#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# JeikCode npm package build script
# Usage:  ./scripts/build_npm_package.sh <version>
# Example: ./scripts/build_npm_package.sh 7.5.3 --dry-run
#          ./scripts/build_npm_package.sh 7.5.3
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="jeikl/JeikCode"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

# ── resolve version ──
if [ $# -ge 1 ] && [[ "$1" != -* ]]; then
    VERSION="$1"
    shift
else
    VERSION=$(curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/Cargo.toml" | awk '
        /^\[workspace\.package\]/ { w = 1; next }
        /^\[/ { w = 0 }
        w && /^version *=/ { gsub(/.*"|".*/, ""); print; exit }')
    if [[ -z "$VERSION" ]]; then
        echo "Error: failed to read [workspace.package].version from Cargo.toml"
        exit 1
    fi
fi

# Capture remaining args for npm publish (e.g. --dry-run, --otp=...)
NPM_EXTRA="${*:-}"

NPM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# Keep this list in sync with scripts/platforms.json (checked by
# `node scripts/platforms.js --check`).
PLATFORMS=(
  "darwin-arm64:darwin:arm64"
  "darwin-x64:darwin:x64"
  "linux-arm64:linux:arm64"
  "linux-x64:linux:x64"
  "win32-x64:win32:x64"
)

publish_platform() {
  local tag="$1" os="$2" arch="$3"
  local dir="$WORK_DIR/$tag"
  mkdir -p "$dir/bin"

  # The wrapper (bin/jeikcode.js) resolves these names.
  cat > "$dir/package.json" <<EOF
{"name":"@github.com/jeikcode-${tag}","version":"${VERSION}-${tag}","os":["${os}"],"cpu":["${arch}"],"files":["bin/"]}
EOF

  local dl_os="$os"
  local ext=""
  [ "$os" = "win32" ] && dl_os="windows" && ext=".exe"
  local bin_name="jeikcode${ext}"
  local url="https://github.com/${REPO}/releases/download/v${VERSION}/jeikcode-v${VERSION}-${dl_os}-${arch}${ext}"

  echo "  ↓ downloading ${tag}..."
  local http_code
  if [ -n "$GITHUB_TOKEN" ]; then
    http_code=$(curl -fsSL -w '%{http_code}' -H "Authorization: Bearer ${GITHUB_TOKEN}" --connect-timeout 30 --retry 3 "$url" -o "$dir/bin/$bin_name" 2>/dev/null)
  else
    http_code=$(curl -fsSL -w '%{http_code}' --connect-timeout 30 --retry 3 "$url" -o "$dir/bin/$bin_name" 2>/dev/null)
  fi
  if [ "$http_code" = "404" ]; then
    echo "  ⚠ binary not found for ${tag}, skipping"
    rm -f "$dir/bin/$bin_name"
    return 0
  fi
  chmod +x "$dir/bin/$bin_name"

  cd "$dir"
  npm publish --registry=https://registry.npmjs.org/ --access public $NPM_EXTRA
  echo "  ✓ @github.com/jeikcode-${tag}@${VERSION}-${tag}"
}

echo ""
echo "  Publishing @github.com/jeikcode v${VERSION}"
echo ""

# 1. publish platform versions
for entry in "${PLATFORMS[@]}"; do
  IFS=: read -r tag os arch <<< "$entry"
  publish_platform "$tag" "$os" "$arch"
done

# 2. publish core
CORE_DIR="$WORK_DIR/core"
mkdir -p "$CORE_DIR/bin"
cp "$NPM_DIR/package.json" "$CORE_DIR/"
cp "$NPM_DIR/bin/jeikcode.js" "$CORE_DIR/bin/"
cd "$CORE_DIR"
# Inject version + optionalDependencies (same names as bin/jeikcode.js).
node -e "
var fs = require('fs');
var pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$VERSION';
pkg.optionalDependencies = {
  '@github.com/jeikcode-darwin-arm64': 'npm:@github.com/jeikcode@$VERSION-darwin-arm64',
  '@github.com/jeikcode-darwin-x64': 'npm:@github.com/jeikcode@$VERSION-darwin-x64',
  '@github.com/jeikcode-linux-arm64': 'npm:@github.com/jeikcode@$VERSION-linux-arm64',
  '@github.com/jeikcode-linux-x64': 'npm:@github.com/jeikcode@$VERSION-linux-x64',
  '@github.com/jeikcode-win32-x64': 'npm:@github.com/jeikcode@$VERSION-win32-x64'
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
npm publish --registry=https://registry.npmjs.org/ --access public $NPM_EXTRA
echo "  ✓ @github.com/jeikcode@${VERSION} (core)"
echo ""
echo "  All done!"
