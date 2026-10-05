#!/usr/bin/env python3
"""Regression tests for the explicit developer asset-import helper."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parent.parent
HELPER = REPO_ROOT / "scripts" / "sync-dev-assets.py"


class SyncDevAssetsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="jeikcode-sync-assets-test-")
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.repo = self.root / "repo"
        (self.home / "prompts").mkdir(parents=True)
        self.repo.mkdir()
        (self.repo / "Cargo.toml").write_text("[workspace]\n")
        (self.home / "prompts" / "demo.yaml").write_text("demo: true\n")
        (self.home / "prompts" / "prompts.md").write_text("excluded\n")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_helper(self, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(HELPER),
                "--home",
                str(self.home),
                "--repo-root",
                str(self.repo),
                *extra,
            ],
            text=True,
            capture_output=True,
            timeout=30,
        )

    def destination(self) -> Path:
        return self.repo / "crates" / "jeikcode-coding" / "assets" / "prompts" / "demo.yaml"

    def test_dry_run_reports_but_does_not_mutate(self) -> None:
        result = self.run_helper("--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("1 asset file(s) would change.", result.stdout)
        self.assertFalse(self.destination().exists())

    def test_copy_preserves_prompt_exclusion_and_second_run_is_noop(self) -> None:
        first = self.run_helper()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.destination().read_text(), "demo: true\n")
        excluded = self.destination().parent / "prompts.md"
        self.assertFalse(excluded.exists())

        second = self.run_helper()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("0 asset file(s) changed.", second.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
