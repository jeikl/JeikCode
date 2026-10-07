#!/usr/bin/env bash
# Retired release entry point; the previous implementation is preserved in Git history.
printf '%s\n' 'Retired: scripts/release-self-update.sh no longer changes versions, builds or prepares uploads.' 'Use the official main/tag GitHub Actions pipeline documented in docs/release-tutorial.md.' >&2
exit 1
