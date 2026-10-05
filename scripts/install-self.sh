#!/bin/sh
# Backward-compatible installer entrypoint.
# The authoritative implementation is scripts/install.sh; keep this alias thin
# so security/integrity behavior cannot drift between two download paths.
set -eu

case "$0" in
    */install-self.sh|install-self.sh)
        if [ -f "$0" ]; then
            SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
            if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/install.sh" ]; then
                exec sh "$SCRIPT_DIR/install.sh" "$@"
            fi
        fi
        ;;
esac

TMP_INSTALLER=$(mktemp)
trap 'rm -f "$TMP_INSTALLER"' EXIT
if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh -o "$TMP_INSTALLER"
elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_INSTALLER" https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh
else
    echo "Error: need curl or wget to load the official JeikCode installer." >&2
    exit 1
fi
exec sh "$TMP_INSTALLER" "$@"
