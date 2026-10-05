#!/usr/bin/env python3
"""Explicitly import developer JeikCode assets into a source checkout.

Cargo builds must be hermetic and never mutate tracked source files from
~/.jeikcode. This helper preserves the old developer import workflow as an
explicit, reviewable operation.
"""

from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


PROMPT_EXCLUDES = {"prompts.md", "内置工具.yaml", "内置技能.yaml"}
TREE_MAPPINGS = (
    ("prompts", "crates/jeikcode-coding/assets/prompts", PROMPT_EXCLUDES),
    ("thesaurus", "crates/jeikcode-capabilities/assets/thesaurus", set()),
    ("teaches", "crates/jeikcode-capabilities/assets/teaches", set()),
)
FILE_MAPPINGS = (
    ("builtin-tools.txt", "crates/jeikcode-capabilities/assets/builtin-tools.txt"),
    (".codegraphignore", "crates/jeikcode-capabilities/assets/.codegraphignore"),
    ("config_teachs.md", "crates/jeikcode-cli/assets/config_teachs.md"),
    ("user-wrap.md", "crates/jeikcode-capabilities/assets/user-wrap.md"),
)


def default_home() -> Path:
    configured = os.environ.get("JEIKCODE_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".jeikcode"


def copy_if_changed(src: Path, dest: Path, dry_run: bool) -> bool:
    if dest.is_file() and src.read_bytes() == dest.read_bytes():
        return False
    print(f"{'would copy' if dry_run else 'copy'}: {src} -> {dest}")
    if not dry_run:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    return True


def sync_assets(home: Path, repo_root: Path, dry_run: bool) -> int:
    changed = 0
    for src_rel, dest_rel, excluded in TREE_MAPPINGS:
        src_dir = home / src_rel
        if not src_dir.is_dir():
            continue
        for src in sorted(src_dir.iterdir()):
            if src.is_file() and src.name not in excluded:
                changed += copy_if_changed(src, repo_root / dest_rel / src.name, dry_run)

    for src_rel, dest_rel in FILE_MAPPINGS:
        src = home / src_rel
        if src.is_file():
            changed += copy_if_changed(src, repo_root / dest_rel, dry_run)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=default_home())
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    home = args.home.expanduser().resolve()
    repo_root = args.repo_root.expanduser().resolve()
    if not home.is_dir():
        parser.error(f"JeikCode home does not exist: {home}")
    if not (repo_root / "Cargo.toml").is_file():
        parser.error(f"repository root is invalid: {repo_root}")

    changed = sync_assets(home, repo_root, args.dry_run)
    verb = "would change" if args.dry_run else "changed"
    print(f"{changed} asset file(s) {verb}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
