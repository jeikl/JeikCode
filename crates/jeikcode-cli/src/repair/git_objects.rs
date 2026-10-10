//! One raw Git object stream per snapshot, with bounded framing and no filters.

use super::{workspace, Context, Path, Result};
use anyhow::ensure;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};

pub(super) struct BlobBatch {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    remaining: u64,
}

impl BlobBatch {
    pub(super) fn new(root: &Path) -> Result<Self> {
        // The caller rejects partial clones before any object request. Reuse the
        // same cleared environment and Git policy as every other repair command.
        let mut child = workspace::git_command(root)
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // No unread stderr pipe can stall this request/response protocol.
            .stderr(Stdio::null())
            .spawn()
            .context("start raw Git object reader")?;
        let input = child.stdin.take().expect("piped Git input");
        let output = BufReader::new(child.stdout.take().expect("piped Git output"));
        Ok(Self {
            child,
            input: Some(input),
            output,
            remaining: workspace::MAX_SOURCE_BYTES,
        })
    }

    pub(super) fn read(&mut self, sha: &str, budget: u64) -> Result<Vec<u8>> {
        ensure!(valid_id(sha), "invalid Git blob id");
        let input = self.input.as_mut().context("Git object reader is closed")?;
        writeln!(input, "{sha}")?;
        input.flush()?;
        // A single outstanding request avoids stdin/stdout backpressure even
        // when a blob is larger than an OS pipe buffer.
        let bytes = read_response(&mut self.output, sha, budget.min(self.remaining))?;
        self.remaining -= bytes.len() as u64;
        Ok(bytes)
    }

    pub(super) fn finish(mut self) -> Result<()> {
        drop(self.input.take());
        let mut extra = [0u8; 1];
        ensure!(
            self.output.read(&mut extra)? == 0,
            "unexpected trailing Git object data"
        );
        ensure!(self.child.wait()?.success(), "Git object reader failed");
        Ok(())
    }
}

impl Drop for BlobBatch {
    fn drop(&mut self) {
        // Early framing, filesystem, or identity errors must not leak a reader
        // waiting for its next request. Normal finish has already reaped it.
        drop(self.input.take());
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn valid_id(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit())
}

fn read_response(reader: &mut impl BufRead, sha: &str, budget: u64) -> Result<Vec<u8>> {
    ensure!(valid_id(sha), "invalid Git blob id");
    let mut header = Vec::new();
    (&mut *reader).take(128).read_until(b'\n', &mut header)?;
    ensure!(
        header.last() == Some(&b'\n'),
        "missing or oversized Git object header"
    );
    let header = std::str::from_utf8(&header[..header.len() - 1])?;
    let fields: Vec<_> = header.split(' ').collect();
    ensure!(
        fields.len() != 2 || fields[1] != "missing",
        "requested Git blob is missing"
    );
    ensure!(
        fields.len() == 3 && fields[0].eq_ignore_ascii_case(sha) && fields[1] == "blob",
        "Git response must name the requested blob"
    );
    ensure!(
        !fields[2].is_empty() && fields[2].bytes().all(|c| c.is_ascii_digit()),
        "invalid Git blob size"
    );
    let size: u64 = fields[2].parse().context("Git blob size overflow")?;
    ensure!(
        size <= budget.min(workspace::MAX_SOURCE_BYTES),
        "Git blob exceeds source snapshot limit"
    );
    let size = usize::try_from(size).context("Git blob cannot fit in memory")?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .context("allocate bounded Git blob")?;
    bytes.resize(size, 0);
    reader
        .read_exact(&mut bytes)
        .context("truncated Git blob")?;
    let mut separator = [0];
    reader
        .read_exact(&mut separator)
        .context("missing Git blob delimiter")?;
    ensure!(separator[0] == b'\n', "invalid Git blob delimiter");
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const ID: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn protocol_preserves_binary_empty_and_newline_payloads() {
        let payloads: &[&[u8]] = &[b"\0\xff\r\nblob\n", b"", b"\n"];
        let mut stream = Vec::new();
        for bytes in payloads {
            stream.extend_from_slice(format!("{ID} blob {}\n", bytes.len()).as_bytes());
            stream.extend_from_slice(bytes);
            stream.push(b'\n');
        }
        let mut reader = Cursor::new(stream);
        for bytes in payloads {
            assert_eq!(read_response(&mut reader, ID, 32).unwrap(), *bytes);
        }
        assert_eq!(reader.position(), reader.get_ref().len() as u64);
    }

    #[test]
    fn protocol_rejects_invalid_identity_type_sizes_and_framing() {
        for body in [
            format!("{} blob 0\n\n", "f".repeat(40)),
            format!("{ID} tree 0\n\n"),
            format!("{ID} missing\n"),
            format!("{ID} blob -1\n"),
            format!("{ID} blob +1\nx\n"),
            format!("{ID} blob 18446744073709551616\n"),
            format!("{ID} blob 268435457\n"),
            format!("{ID} blob 0 extra\n\n"),
            format!("{ID} blob 3\na"),
            format!("{ID} blob 1\na!"),
            format!("{ID} blob 0\n"),
            "x".repeat(129),
            "".into(),
        ] {
            assert!(
                read_response(&mut Cursor::new(body.as_bytes()), ID, u64::MAX).is_err(),
                "accepted malformed frame: {body:?}"
            );
        }
    }

    #[test]
    fn budget_is_checked_before_reading_a_payload() {
        let header = format!("{ID} blob 10\n");
        let mut input = Cursor::new(format!("{header}0123456789\n").into_bytes());
        let error = read_response(&mut input, ID, 9).unwrap_err();
        assert!(error.to_string().contains("snapshot limit"));
        assert_eq!(input.position(), header.len() as u64);
        assert!(read_response(&mut Cursor::new(b""), "HEAD\n", 1).is_err());
    }
}
