//! Deliberately reviewed runtime policy, not a general sandbox certification.

use super::*;
#[cfg(any(test, target_os = "linux"))]
use anyhow::ensure;

pub(super) const SYSTEM_PATH: &str = "/usr/bin/bwrap";
const VERSION: &str = "0.13.0";
const POLICY: &str = "bubblewrap-0.13.0-system-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub(super) path: String,
    pub(super) version: String,
    pub(super) binary_sha256: String,
    pub(super) qualification_policy: String,
}

impl Identity {
    pub(super) fn matches_policy(&self) -> bool {
        self.path == SYSTEM_PATH
            && self.version == VERSION
            && self.qualification_policy == POLICY
            && self.binary_sha256.len() == 64
            && self.binary_sha256.bytes().all(|b| b.is_ascii_hexdigit())
    }
}

#[cfg(any(test, target_os = "linux"))]
fn require_version(output: &[u8]) -> Result<()> {
    ensure!(
        output == b"bubblewrap 0.13.0\n",
        "requires reviewed upstream bubblewrap 0.13.0; older, unrecognized and unreviewed versions are blocked"
    );
    Ok(())
}

#[cfg(any(test, target_os = "linux"))]
fn require_file_policy(regular: bool, uid: u32, mode: u32, size: u64) -> Result<()> {
    ensure!(
        regular && uid == 0,
        "sandbox runtime must be a root-owned regular file"
    );
    ensure!(
        mode & 0o6022 == 0 && mode & 0o111 != 0,
        "sandbox runtime must be executable, non-setuid and not group/other writable"
    );
    ensure!(
        size > 0 && size <= 16 * 1024 * 1024,
        "invalid sandbox runtime size"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn fingerprint(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::fs::{self, OpenOptions};
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    ensure!(
        path == Path::new(SYSTEM_PATH),
        "sandbox runtime path is not the fixed system path"
    );
    workspace::no_links(path)?;
    ensure!(
        path.canonicalize()? == path,
        "sandbox runtime path must be canonical"
    );
    for parent in path.ancestors().skip(1) {
        let meta = fs::symlink_metadata(parent)?;
        ensure!(
            meta.is_dir() && meta.uid() == 0 && meta.mode() & 0o022 == 0,
            "sandbox runtime parent must be root-owned and not group/other writable"
        );
    }
    let meta = fs::symlink_metadata(path)?;
    require_file_policy(meta.is_file(), meta.uid(), meta.mode(), meta.len())?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let opened = file.metadata()?;
    require_file_policy(opened.is_file(), opened.uid(), opened.mode(), opened.len())?;
    ensure!(
        meta.dev() == opened.dev() && meta.ino() == opened.ino(),
        "sandbox runtime changed while opening"
    );
    let caps = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            c"security.capability".as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    ensure!(
        caps == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA),
        "sandbox runtime file capabilities must be absent and readable"
    );
    let mut digest = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ensure!(total <= opened.len(), "sandbox runtime grew while reading");
        digest.update(&buffer[..n]);
    }
    ensure!(
        total == opened.len(),
        "sandbox runtime changed while reading"
    );
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(target_os = "linux")]
pub(super) fn qualify(path: &Path) -> Result<Identity> {
    let binary_sha256 = fingerprint(path)?;
    require_version(&super::runner::runtime_version_output(path)?)?;
    ensure!(
        fingerprint(path)? == binary_sha256,
        "sandbox runtime changed during qualification"
    );
    Ok(Identity {
        path: SYSTEM_PATH.into(),
        version: VERSION.into(),
        binary_sha256,
        qualification_policy: POLICY.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_version_policy_rejects_old_malformed_and_unreviewed_versions() {
        require_version(b"bubblewrap 0.13.0\n").unwrap();
        for output in [
            b"bubblewrap 0.6.1\n".as_slice(),
            b"bubblewrap 0.12.0\n",
            b"bubblewrap 0.14.0\n",
            b"bubblewrap 0.13.0-custom\n",
            b"bubblewrap 0.13.0\nextra",
            b"",
            b"0.13.0\n",
        ] {
            assert!(require_version(output).is_err());
        }
    }

    #[test]
    fn runtime_metadata_policy_rejects_writable_privileged_or_nonregular_files() {
        require_file_policy(true, 0, 0o100755, 1000).unwrap();
        for (regular, uid, mode, size) in [
            (false, 0, 0o755, 1),
            (true, 1000, 0o755, 1),
            (true, 0, 0o777, 1),
            (true, 0, 0o4755, 1),
            (true, 0, 0o2755, 1),
            (true, 0, 0o644, 1),
            (true, 0, 0o755, 0),
            (true, 0, 0o755, 16777217),
        ] {
            assert!(require_file_policy(regular, uid, mode, size).is_err());
        }
    }

    #[test]
    fn receipt_runtime_identity_must_match_the_reviewed_policy() {
        let original = Identity {
            path: SYSTEM_PATH.into(),
            version: VERSION.into(),
            binary_sha256: "a".repeat(64),
            qualification_policy: POLICY.into(),
        };
        assert!(original.matches_policy());
        let mut changed = original.clone();
        changed.version = "0.6.1".into();
        assert!(!changed.matches_policy());
        let mut changed = original.clone();
        changed.path = "/tmp/bwrap".into();
        assert!(!changed.matches_policy());
        let mut changed = original.clone();
        changed.binary_sha256 = "unknown".into();
        assert!(!changed.matches_policy());
        let mut changed = original;
        changed.qualification_policy = "future-policy".into();
        assert!(!changed.matches_policy());
    }
}
