use std::path::PathBuf;

pub const STATE_FILE: &str = ".runtime_state";

pub fn state_path() -> PathBuf {
    super::Config::config_dir().join(STATE_FILE)
}

pub fn is_dead() -> bool {
    let path = state_path();
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => match std::fs::read_to_string(&path) {
            Ok(raw) => !raw.trim().eq_ignore_ascii_case("alive"),
            Err(_) => true,
        },
        _ => false,
    }
}

pub fn set_dead() -> std::io::Result<PathBuf> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, "dead")?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_state_is_alive() {
        let _home = crate::test_util::isolated_home();
        assert!(!is_dead());
    }

    #[test]
    fn alive_and_dead_tokens() {
        let _home = crate::test_util::isolated_home();
        set_dead().unwrap();
        assert!(is_dead());
        std::fs::write(state_path(), "alive").unwrap();
        assert!(!is_dead());
    }

    #[test]
    fn unknown_token_stays_dead() {
        let _home = crate::test_util::isolated_home();
        std::fs::write(state_path(), "unexpected").unwrap();
        assert!(is_dead());
    }
}
