#!/usr/bin/env python3
"""End-to-end integrity regressions for the public installer entrypoints."""

from __future__ import annotations

import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest


REPO_ROOT = Path(__file__).resolve().parent.parent
TAG = "v9.9.9"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args: object) -> None:
        pass


class FixtureServer:
    def __init__(self, root: Path):
        def handler(*args, **kwargs):
            return QuietHandler(*args, directory=str(root), **kwargs)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class InstallerIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="jeikcode-installer-test-")
        self.root = Path(self.temp.name)
        self.server_root = self.root / "server"
        self.prefix = self.root / "prefix"
        self.home = self.root / "home"
        self.server_root.mkdir()
        self.prefix.mkdir()
        self.home.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def target(self) -> tuple[str, str, bytes, str]:
        if os.name == "nt":
            return "windows-x64", ".exe", Path(sys.executable).read_bytes(), "AMD64"
        if platform.system() == "Linux" and platform.machine() in {"x86_64", "amd64"}:
            return "linux-x64", "", b"#!/bin/sh\necho jeikcode-test\n", "x86_64"
        self.skipTest("installer regression targets GitHub Windows/Linux x64 runners")

    def write_fixture(
        self,
        *,
        hash_override: str | None = None,
        size_override: int | None = None,
        version: str = TAG,
        include_target: bool = True,
        compact: bool = False,
    ) -> None:
        target, ext, payload, _arch = self.target()
        asset = f"jeikcode-{TAG}-{target}{ext}"
        asset_path = self.server_root / "releases" / "download" / TAG / asset
        asset_path.parent.mkdir(parents=True, exist_ok=True)
        asset_path.write_bytes(payload)

        binaries = {}
        if include_target:
            binaries[target] = {
                "sha256": hash_override if hash_override is not None else sha256(payload),
                "size": size_override if size_override is not None else len(payload),
            }
        manifest = {"version": version, "released_at": "2026-10-05", "binaries": binaries}
        manifest_path = self.server_root / "latest.json"
        if compact:
            manifest_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        else:
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    def run_installer(
        self,
        base_url: str,
        *,
        manifest: str = "latest.json",
        requested_version: str | None = None,
        architecture: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        _target, _ext, _payload, arch = self.target()
        env = os.environ.copy()
        env.update(
            {
                "JEIKCODE_MANIFEST_URL": f"{base_url}/{manifest}",
                "JEIKCODE_DOWNLOAD_BASE": f"{base_url}/releases/download",
                "JEIKCODE_PREFIX": str(self.prefix),
                "JEIKCODE_HOME": str(self.root / "missing-home"),
                "HOME": str(self.home),
                "JEIKCODE_NO_PATH_UPDATE": "1",
            }
        )
        if requested_version is None:
            env.pop("JEIKCODE_VERSION", None)
        else:
            env["JEIKCODE_VERSION"] = requested_version

        if os.name == "nt":
            env["PROCESSOR_ARCHITECTURE"] = architecture or arch
            env.pop("PROCESSOR_ARCHITEW6432", None)
            ps_bin = shutil.which("pwsh") or shutil.which("powershell") or "powershell"
            return subprocess.run(
                [
                    ps_bin,
                    "-NoProfile",
                    "-File",
                    str(REPO_ROOT / "scripts" / "install-self.ps1"),
                ],
                env=env,
                text=True,
                errors="replace",
                capture_output=True,
                timeout=45,
            )

        return subprocess.run(
            ["sh", str(REPO_ROOT / "scripts" / "install-self.sh")],
            env=env,
            text=True,
            errors="replace",
            capture_output=True,
            timeout=45,
        )

    def installed_path(self) -> Path:
        return self.prefix / ("jeikcode.exe" if os.name == "nt" else "jeikcode")

    def seed_existing_install(self) -> None:
        self.installed_path().write_bytes(b"KEEP")

    def assert_preserved_failure(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.installed_path().read_bytes(), b"KEEP")

    def test_valid_pretty_manifest_installs_verified_payload(self) -> None:
        self.write_fixture()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Verified SHA256 and size", result.stdout)
        self.assertTrue(self.installed_path().is_file())

    def test_valid_minified_manifest_honors_explicit_version(self) -> None:
        self.write_fixture(compact=True)
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base, requested_version="9.9.9")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Verified SHA256 and size", result.stdout)

    def test_sha_mismatch_preserves_existing_install(self) -> None:
        self.write_fixture(hash_override="0" * 64)
        self.seed_existing_install()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base)
        self.assert_preserved_failure(result)

    def test_size_mismatch_preserves_existing_install(self) -> None:
        _target, _ext, payload, _arch = self.target()
        self.write_fixture(size_override=len(payload) + 1)
        self.seed_existing_install()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base)
        self.assert_preserved_failure(result)

    def test_missing_target_preserves_existing_install(self) -> None:
        self.write_fixture(include_target=False)
        self.seed_existing_install()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base)
        self.assert_preserved_failure(result)

    def test_invalid_sha_metadata_preserves_existing_install(self) -> None:
        self.write_fixture(hash_override="not-a-sha256")
        self.seed_existing_install()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base)
        self.assert_preserved_failure(result)

    def test_invalid_size_metadata_preserves_existing_install(self) -> None:
        self.write_fixture(size_override=0)
        self.seed_existing_install()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base)
        self.assert_preserved_failure(result)

    def test_unreachable_manifest_has_no_version_fallback(self) -> None:
        self.write_fixture()
        self.seed_existing_install()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base, manifest="missing.json")
        self.assert_preserved_failure(result)

    def test_explicit_version_must_match_custom_manifest(self) -> None:
        self.write_fixture(version="v9.9.8")
        self.seed_existing_install()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base, requested_version=TAG)
        self.assert_preserved_failure(result)
        self.assertIn("manifest reports", result.stdout + result.stderr)

    @unittest.skipUnless(os.name == "nt", "PowerShell compatibility-wrapper status propagation")
    def test_powershell_wrapper_propagates_explicit_exit_failure(self) -> None:
        self.write_fixture()
        with FixtureServer(self.server_root) as base:
            result = self.run_installer(base, architecture="MIPS64")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Unsupported architecture", result.stdout + result.stderr)

    @unittest.skipIf(os.name == "nt", "POSIX compatibility-wrapper fallback")
    def test_remote_compat_wrapper_fails_when_fetch_fails(self) -> None:
        wrapper_dir = self.root / "wrapper-only"
        wrapper_dir.mkdir()
        wrapper = wrapper_dir / "install-self.sh"
        wrapper.write_bytes((REPO_ROOT / "scripts" / "install-self.sh").read_bytes())

        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        fake_curl = fake_bin / "curl"
        fake_curl.write_text("#!/bin/sh\nexit 22\n")
        fake_curl.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{fake_bin}{os.pathsep}{env.get('PATH', '')}"
        result = subprocess.run(
            ["sh", str(wrapper)],
            env=env,
            text=True,
            errors="replace",
            capture_output=True,
            timeout=20,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipIf(os.name == "nt", "POSIX piped compatibility-wrapper mode")
    def test_piped_compat_wrapper_never_executes_cwd_install_sh(self) -> None:
        cwd = self.root / "pipe-cwd"
        cwd.mkdir()
        sentinel = cwd / "cwd-installer-ran"
        local_installer = cwd / "install.sh"
        local_installer.write_text(
            "#!/bin/sh\nprintf ran > " + str(sentinel).replace(" ", "\\ ") + "\n"
        )
        local_installer.chmod(0o755)

        fake_bin = self.root / "fake-pipe-bin"
        fake_bin.mkdir()
        fake_curl = fake_bin / "curl"
        fake_curl.write_text("#!/bin/sh\nexit 22\n")
        fake_curl.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{fake_bin}{os.pathsep}{env.get('PATH', '')}"
        result = subprocess.run(
            ["sh"],
            input=(REPO_ROOT / "scripts" / "install-self.sh").read_text(),
            cwd=cwd,
            env=env,
            text=True,
            errors="replace",
            capture_output=True,
            timeout=20,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(sentinel.exists(), "piped wrapper executed cwd install.sh")


if __name__ == "__main__":
    unittest.main(verbosity=2)
