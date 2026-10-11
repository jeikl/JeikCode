#!/usr/bin/env python3
"""Exercise real CLI build.rs watcher directives without a Cargo target cache."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
BUILD_SCRIPT = Path(
    os.environ.get(
        "JEIKCODE_BUILD_WATCH_TEST_SOURCE",
        str(ROOT / "crates" / "jeikcode-cli" / "build.rs"),
    )
).resolve()

WINRESOURCE_STUB = """
pub struct WindowsResource;
#[allow(non_snake_case)]
pub mod VersionInfo { pub const FILETYPE: u32 = 1; }
impl WindowsResource {
    pub fn new() -> Self { Self }
    pub fn set_icon(&mut self, _: &str) {}
    pub fn set_manifest(&mut self, _: &str) {}
    pub fn set_version_info(&mut self, _: u32, _: u64) {}
    pub fn compile(&mut self) -> Result<(), std::io::Error> { Ok(()) }
}
"""


def isolated_git_env(env=None):
    """Prevent host repo overrides, signing and Git configs from leaking into fixtures."""
    source = os.environ if env is None else env
    cleaned = {key: value for key, value in source.items() if not key.startswith("GIT_")}
    cleaned["GIT_CONFIG_NOSYSTEM"] = "1"
    cleaned["GIT_CONFIG_GLOBAL"] = os.devnull
    return cleaned


def git_command(*args):
    return [
        "git",
        "-c", f"core.hooksPath={os.devnull}",
        "-c", "core.autocrlf=false",
        "-c", "commit.gpgsign=false",
        *[str(arg) for arg in args],
    ]


def run(*args, cwd=None, env=None):
    is_git = str(args[0]) == "git"
    return subprocess.run(
        git_command(*args[1:]) if is_git else [str(arg) for arg in args],
        cwd=cwd,
        env=isolated_git_env(env) if is_git else env,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()


def resolved_git_path(repo, entry):
    raw = Path(run("git", "-C", repo, "rev-parse", "--git-path", entry))
    return (raw if raw.is_absolute() else repo / raw).resolve()


def tracked_paths(repo):
    result = subprocess.run(
        git_command("-C", repo, "ls-files", "--cached", "-z"),
        env=isolated_git_env(),
        check=True,
        capture_output=True,
    )
    return {
        (repo / os.fsdecode(entry)).resolve()
        for entry in result.stdout.split(b"\0")
        if entry
    }


class BuildWatchContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tooling = tempfile.TemporaryDirectory(prefix="jeikcode-build-watch-tools-")
        tools = Path(cls.tooling.name)
        stub = tools / "winresource_stub.rs"
        stub.write_text(WINRESOURCE_STUB, encoding="utf-8")
        library = tools / "libwinresource.rlib"
        binary = tools / ("build-watch.exe" if os.name == "nt" else "build-watch")
        run(
            "rustc",
            "--edition=2021",
            "--crate-type=rlib",
            "--crate-name=winresource",
            stub,
            "-o",
            library,
        )
        run("rustc", "--edition=2021", BUILD_SCRIPT, "--extern", f"winresource={library}", "-o", binary)
        cls.binary = binary

    @classmethod
    def tearDownClass(cls):
        cls.tooling.cleanup()

    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix="jeikcode-build-watch-git-")
        self.repo = Path(self.fixture.name) / "repo"
        self.create_fixture(self.repo)

    @staticmethod
    def create_fixture(repo):
        repo.mkdir()
        (repo / "crates" / "jeikcode-cli").mkdir(parents=True)
        (repo / "docs").mkdir()
        (repo / "webui").mkdir()
        (repo / "docs" / "guide.md").write_text("initial\n", encoding="utf-8")
        (repo / "webui" / "app.ts").write_text("export {};\n", encoding="utf-8")
        (repo / "crates" / "jeikcode-cli" / "fixture.txt").write_text("crate\n", encoding="utf-8")
        run("git", "init", "-q", "-b", "main", repo)
        run("git", "-C", repo, "add", "--all")
        run(
            "git",
            "-C",
            repo,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
        )

    def tearDown(self):
        self.fixture.cleanup()

    def probe(self, repo=None, all_files=False):
        repo = repo or self.repo
        env = isolated_git_env()
        env.pop("JEIKCODE_BUILD_WATCH_ALL", None)
        env.update(
            CARGO_MANIFEST_DIR=str(repo / "crates" / "jeikcode-cli"),
            CARGO_CFG_TARGET_OS="linux",
            CARGO_BIN_NAME="jeikcode",
            TARGET="x86_64-unknown-linux-gnu",
        )
        if all_files:
            env["JEIKCODE_BUILD_WATCH_ALL"] = "1"
        output = run(self.binary, env=env).splitlines()
        watches = {
            Path(value).resolve()
            for line in output
            if line.startswith("cargo:rerun-if-changed=")
            for value in [line.partition("=")[2]]
            if value != "build.rs"
        }
        return output, watches

    def assert_metadata_only(self, repo, output, watches):
        self.assertIn("cargo:rerun-if-changed=build.rs", output)
        self.assertIn("cargo:rerun-if-env-changed=JEIKCODE_BUILD_WATCH_ALL", output)
        for name in ("HEAD", "index"):
            self.assertIn(resolved_git_path(repo, name), watches)
        symbolic_ref = subprocess.run(
            git_command("-C", repo, "symbolic-ref", "--quiet", "HEAD"),
            env=isolated_git_env(),
            text=True,
            capture_output=True,
        ).stdout.strip()
        if symbolic_ref:
            self.assertIn(resolved_git_path(repo, symbolic_ref), watches)
        self.assertTrue(
            tracked_paths(repo).isdisjoint(watches),
            f"default build still watches tracked files: {tracked_paths(repo) & watches}",
        )
        self.assertTrue(all(path.is_file() for path in watches), f"directory watched: {watches}")

    def test_default_does_not_watch_unrelated_tracked_files(self):
        output, watches = self.probe()
        self.assert_metadata_only(self.repo, output, watches)

    def test_opt_in_watches_all_tracked_files(self):
        output, watches = self.probe(all_files=True)
        self.assertIn("cargo:rerun-if-env-changed=JEIKCODE_BUILD_WATCH_ALL", output)
        self.assertTrue(
            tracked_paths(self.repo).issubset(watches),
            f"opt-in missed tracked files: {tracked_paths(self.repo) - watches}",
        )
        self.assertTrue(all(path.is_file() for path in watches))

    def test_build_time_dirty_value_remains_exact(self):
        path = self.repo / "docs" / "guide.md"
        path.write_text("unstaged change\n", encoding="utf-8")
        output, _ = self.probe()
        self.assertIn("cargo:rustc-env=JEIKCODE_SOURCE_DIRTY=true", output)
        self.assertIn("cargo:rustc-env=JEIKCODE_BUILD_DIRTY=+dirty", output)

    def test_fixture_git_commands_ignore_host_overrides(self):
        hostile_repo = Path(self.fixture.name) / "hostile"
        hostile = {
            "GIT_DIR": str(hostile_repo / "not-our-git-dir"),
            "GIT_WORK_TREE": str(hostile_repo / "other-worktree"),
            "GIT_CONFIG_GLOBAL": str(hostile_repo / "missing-global-config"),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "commit.gpgsign",
            "GIT_CONFIG_VALUE_0": "true",
        }
        with patch.dict(os.environ, hostile):
            # Exercise the harness's actual Git fixture setup under hostile
            # inherited config. This does not assert that build.rs itself
            # sanitizes arbitrary user Git configuration.
            self.create_fixture(hostile_repo)
            linked = Path(self.fixture.name) / "hostile-linked"
            run("git", "-C", hostile_repo, "worktree", "add", "-q", "-b", "linked", linked, "HEAD")
            output, watches = self.probe(repo=linked)
            self.assert_metadata_only(linked, output, watches)
            self.assertIn((linked / ".git").resolve(), watches)
            self.assertIn("cargo:rustc-env=JEIKCODE_SOURCE_DIRTY=false", output)

    def test_detached_head_uses_metadata_without_symbolic_ref(self):
        run("git", "-C", self.repo, "checkout", "-q", "--detach", "HEAD")
        output, watches = self.probe()
        self.assert_metadata_only(self.repo, output, watches)
        self.assertIn("cargo:rustc-env=JEIKCODE_SOURCE_DIRTY=false", output)

    def test_linked_worktree_uses_git_paths_and_pointer_file(self):
        linked = Path(self.fixture.name) / "linked"
        run("git", "-C", self.repo, "worktree", "add", "-q", "-b", "linked", linked, "HEAD")
        output, watches = self.probe(repo=linked)
        self.assert_metadata_only(linked, output, watches)
        self.assertIn((linked / ".git").resolve(), watches)
        self.assertTrue((linked / ".git").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
