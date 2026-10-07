#!/bin/bash
# Retired release entry point; the previous implementation is preserved in Git history.
printf '%s\n' 'Retired: scripts/release.sh no longer builds release artifacts or writes latest.json.' 'Use the official main/tag GitHub Actions pipeline documented in docs/release-tutorial.md.' >&2
exit 1
