//! Skills Marketplace Client Registry & Sync Pre-flight Engine.
//!
//! Provides client-side manifest parsing, version update detection, and SHA-256
//! integrity verification for community and official skills hosted on `jeik-skills-hub`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const DEFAULT_SKILLS_HUB_REPO: &str = "https://github.com/jeikl/jeik-skills-hub";

/// 单个技能文件的完整性元数据
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketplaceSkillFile {
    /// 相对技能根目录的相对路径（如 "SKILL.md", "scripts/fetch.py"）
    pub relative_path: String,
    /// 文件的标准 SHA-256 十六进制哈希（小写）
    pub sha256: String,
    /// 文件字节大小
    #[serde(default)]
    pub size_bytes: u64,
}

/// 技能市场中的单个技能清单定义（与 jeik-skills-hub 仓库结构完全对齐）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketplaceSkillManifest {
    /// 技能唯一标识符（例如 "jeik-web-fetch", "animate", "graft"）
    pub id: String,
    /// 技能人类可读名称
    pub name: String,
    /// 语义化版本号 (例如 "1.0.0", "1.2.1")
    pub version: String,
    /// 技能功能与适用场景描述
    pub description: String,
    /// 技能作者（默认 "jeikl"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// 来源仓库链接
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// 所需最低 JeikCode 版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_jeikcode_version: Option<String>,
    /// 包含的文件清单及其完整性校验码
    #[serde(default)]
    pub files: Vec<MarketplaceSkillFile>,
    /// 技能整体签名/校验和 (SHA-256)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    /// 分类标签（例如 ["web", "scrape", "spa"]）
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 技能市场全量索引清单 (`marketplace.json` / `skills-hub-index.json`)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketplaceIndex {
    /// 市场元数据架构版本
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// 市场索引最新更新时间戳 (Unix 秒)
    #[serde(default)]
    pub updated_at: u64,
    /// 官方技能市场 Hub 仓库
    #[serde(default = "default_hub_repo")]
    pub hub_repo: String,
    /// 收录的技能列表
    #[serde(default)]
    pub skills: Vec<MarketplaceSkillManifest>,
}

fn default_schema_version() -> u32 {
    1
}

fn default_hub_repo() -> String {
    DEFAULT_SKILLS_HUB_REPO.to_string()
}

/// 本地安装状态与市场最新版本的比对结果
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SkillUpdateStatus {
    /// 本地未安装此技能
    NotInstalled,
    /// 已是最新版本且完整性校验通过
    UpToDate { version: String },
    /// 发现新版本（提示用户可更新）
    UpdateAvailable {
        current_version: String,
        latest_version: String,
    },
    /// 本地文件被修改或哈希不匹配（被用户本地定制）
    ModifiedLocally {
        current_version: String,
        modified_files: Vec<String>,
    },
}

/// 完整性校验错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillIntegrityError {
    MissingFile(String),
    ChecksumMismatch {
        file: String,
        expected: String,
        actual: String,
    },
    IoError(String),
    InvalidPath(String),
}

impl std::fmt::Display for SkillIntegrityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingFile(p) => write!(f, "Missing expected skill file: {p}"),
            Self::ChecksumMismatch {
                file,
                expected,
                actual,
            } => {
                write!(
                    f,
                    "Integrity checksum mismatch for {file}: expected {expected}, got {actual}"
                )
            }
            Self::IoError(e) => write!(f, "IO error during integrity check: {e}"),
            Self::InvalidPath(p) => {
                write!(f, "Invalid relative path traversal in skill manifest: {p}")
            }
        }
    }
}

impl std::error::Error for SkillIntegrityError {}

impl MarketplaceIndex {
    /// 解析技能市场 JSON 清单
    pub fn from_json(json_str: &str) -> Result<Self, String> {
        serde_json::from_str(json_str)
            .map_err(|e| format!("Failed to parse marketplace index JSON: {e}"))
    }

    /// 根据技能 ID 查找技能清单
    pub fn find_skill(&self, id: &str) -> Option<&MarketplaceSkillManifest> {
        let needle = id.trim().to_lowercase();
        self.skills.iter().find(|s| s.id.to_lowercase() == needle)
    }
}

/// 计算指定文件的 SHA-256 哈希字符串（小写十六进制）
pub fn compute_file_sha256(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hasher.finalize();
    Ok(format!("{:x}", hash))
}

/// 计算内存字节数据的 SHA-256 哈希字符串（小写十六进制）
pub fn compute_bytes_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// 校验技能清单中的相对文件路径是否安全（防止路径穿越逃逸出技能根目录）
pub fn is_safe_relative_path(path: &str) -> bool {
    let p = Path::new(path);
    if p.is_absolute() {
        return false;
    }
    for comp in p.components() {
        if matches!(
            comp,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            return false;
        }
    }
    true
}

/// 预检与完整性验证：对比指定技能目录中的文件是否与市场清单中的预期哈希一致
pub fn verify_skill_integrity(
    skill_dir: &Path,
    manifest: &MarketplaceSkillManifest,
) -> Result<(), SkillIntegrityError> {
    for entry in &manifest.files {
        if !is_safe_relative_path(&entry.relative_path) {
            return Err(SkillIntegrityError::InvalidPath(
                entry.relative_path.clone(),
            ));
        }
        let file_path = skill_dir.join(&entry.relative_path);
        if !file_path.is_file() {
            return Err(SkillIntegrityError::MissingFile(
                entry.relative_path.clone(),
            ));
        }
        let actual_hash = compute_file_sha256(&file_path).map_err(|e| {
            SkillIntegrityError::IoError(format!("Failed to read {}: {e}", entry.relative_path))
        })?;
        if !actual_hash.eq_ignore_ascii_case(&entry.sha256) {
            return Err(SkillIntegrityError::ChecksumMismatch {
                file: entry.relative_path.clone(),
                expected: entry.sha256.clone(),
                actual: actual_hash,
            });
        }
    }
    Ok(())
}

/// 检查本地安装的技能目录与市场清单的状态（判断是否未安装、有更新、本地被改动、或完全最新）
pub fn check_skill_update_status(
    skill_dir: &Path,
    manifest: &MarketplaceSkillManifest,
) -> SkillUpdateStatus {
    if !skill_dir.is_dir() {
        return SkillUpdateStatus::NotInstalled;
    }

    let skill_md_path = skill_dir.join("SKILL.md");
    if !skill_md_path.is_file() {
        return SkillUpdateStatus::NotInstalled;
    }

    // 从本地 SKILL.md frontmatter 尝试提取 version 字段
    let local_content = match std::fs::read_to_string(&skill_md_path) {
        Ok(c) => c,
        Err(_) => return SkillUpdateStatus::NotInstalled,
    };

    let local_version =
        extract_version_from_frontmatter(&local_content).unwrap_or_else(|| "0.0.0".to_string());

    // 比较版本：若市场版本高于本地版本，则存在更新
    if is_newer_semver(&manifest.version, &local_version) {
        return SkillUpdateStatus::UpdateAvailable {
            current_version: local_version,
            latest_version: manifest.version.clone(),
        };
    }

    // 若版本号相同或本地版本不落后，校验文件完整性，排查是否被用户本地修改
    let mut modified_files = Vec::new();
    for entry in &manifest.files {
        if !is_safe_relative_path(&entry.relative_path) {
            modified_files.push(entry.relative_path.clone());
            continue;
        }
        let fpath = skill_dir.join(&entry.relative_path);
        if !fpath.is_file() {
            modified_files.push(entry.relative_path.clone());
            continue;
        }
        if let Ok(hash) = compute_file_sha256(&fpath) {
            if !hash.eq_ignore_ascii_case(&entry.sha256) {
                modified_files.push(entry.relative_path.clone());
            }
        } else {
            modified_files.push(entry.relative_path.clone());
        }
    }

    if !modified_files.is_empty() {
        SkillUpdateStatus::ModifiedLocally {
            current_version: local_version,
            modified_files,
        }
    } else {
        SkillUpdateStatus::UpToDate {
            version: local_version,
        }
    }
}

/// 从 SKILL.md YAML 前置元数据中提取 version: x.y.z
pub fn extract_version_from_frontmatter(content: &str) -> Option<String> {
    let trimmed = content.trim_start_matches('\u{feff}').trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let rest = &trimmed[3..];
    let end_idx = rest.find("\n---")?;
    let fm = &rest[..end_idx];
    for line in fm.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("version:") {
            let v = val.trim().trim_matches('"').trim_matches('\'').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// 语义化版本对比：遵循 SemVer 2.0.0 规范（支持正式版与预发布版、构建元数据等对比）
pub fn is_newer_semver(candidate: &str, current: &str) -> bool {
    let parse_semver = |v: &str| -> (Vec<u64>, Option<(String, u64)>) {
        let clean = v.trim().trim_start_matches(['v', 'V']);
        let without_build = clean.split_once('+').map(|(base, _)| base).unwrap_or(clean);
        if let Some((main_part, pre_part)) = without_build.split_once('-') {
            let nums: Vec<u64> = main_part
                .split('.')
                .filter_map(|s| s.parse::<u64>().ok())
                .collect();
            let pre_info = if let Some((tag, num_str)) = pre_part.split_once('.') {
                Some((tag.to_lowercase(), num_str.parse::<u64>().unwrap_or(0)))
            } else {
                Some((pre_part.to_lowercase(), 0))
            };
            (nums, pre_info)
        } else {
            let nums: Vec<u64> = without_build
                .split('.')
                .filter_map(|s| s.parse::<u64>().ok())
                .collect();
            (nums, None)
        }
    };

    let (c_nums, c_pre) = parse_semver(candidate);
    let (cur_nums, cur_pre) = parse_semver(current);

    let max_len = c_nums.len().max(cur_nums.len());
    for i in 0..max_len {
        let c = c_nums.get(i).copied().unwrap_or(0);
        let cur = cur_nums.get(i).copied().unwrap_or(0);
        if c > cur {
            return true;
        } else if c < cur {
            return false;
        }
    }

    match (c_pre, cur_pre) {
        (None, Some(_)) => true, // 正式版 > 预发布版 (如 candidate 1.0.0 > current 1.0.0-beta.1)
        (Some(_), None) => false, // 预发布版 < 正式版 (如 candidate 1.0.0-beta.1 < current 1.0.0)
        (Some((c_tag, c_num)), Some((cur_tag, cur_num))) => {
            if c_tag != cur_tag {
                c_tag > cur_tag
            } else {
                c_num > cur_num
            }
        }
        (None, None) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_marketplace_index() {
        let json = r#"{
            "schema_version": 1,
            "updated_at": 1729880000,
            "hub_repo": "https://github.com/jeikl/jeik-skills-hub",
            "skills": [
                {
                    "id": "jeik-web-fetch",
                    "name": "Jeik Web Fetch",
                    "version": "1.1.0",
                    "description": "High performance web fetch engine",
                    "author": "jeikl",
                    "tags": ["web", "scraping"],
                    "files": [
                        {
                            "relative_path": "SKILL.md",
                            "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                            "size_bytes": 0
                        }
                    ]
                }
            ]
        }"#;

        let index = MarketplaceIndex::from_json(json).expect("valid json");
        assert_eq!(index.skills.len(), 1);
        let s = index.find_skill("jeik-web-fetch").expect("found skill");
        assert_eq!(s.name, "Jeik Web Fetch");
        assert_eq!(s.version, "1.1.0");
        assert_eq!(s.files.len(), 1);
    }

    #[test]
    fn test_is_newer_semver() {
        assert!(is_newer_semver("1.1.0", "1.0.0"));
        assert!(is_newer_semver("1.0.1", "1.0.0"));
        assert!(is_newer_semver("2.0.0", "1.9.9"));
        assert!(is_newer_semver("v1.2.0", "1.1.9"));
        assert!(!is_newer_semver("1.0.0", "1.0.0"));
        assert!(!is_newer_semver("1.0.0", "1.1.0"));

        // SemVer 2.0.0 pre-release precedence
        assert!(is_newer_semver("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer_semver("1.0.0-beta.1", "1.0.0"));
        assert!(is_newer_semver("1.0.0-beta.2", "1.0.0-beta.1"));
        assert!(!is_newer_semver("1.0.0-beta.1", "1.0.0-beta.2"));
        assert!(!is_newer_semver("1.0.0+build123", "1.0.0"));
    }

    #[test]
    fn test_extract_version_from_frontmatter() {
        let content = "---\nname: my-skill\nversion: \"1.2.3\"\ndescription: test\n---\n# Content";
        assert_eq!(
            extract_version_from_frontmatter(content),
            Some("1.2.3".to_string())
        );

        let content_unquoted = "---\nname: my-skill\nversion: 2.0.0\n---\n# Content";
        assert_eq!(
            extract_version_from_frontmatter(content_unquoted),
            Some("2.0.0".to_string())
        );

        let with_bom = "\u{feff}---\nname: my-skill\nversion: 3.1.4\n---\n# Content";
        assert_eq!(
            extract_version_from_frontmatter(with_bom),
            Some("3.1.4".to_string())
        );

        let no_version = "---\nname: my-skill\n---\n# Content";
        assert_eq!(extract_version_from_frontmatter(no_version), None);
    }

    #[test]
    fn test_verify_skill_integrity_and_update_status() {
        let temp_dir = tempfile::tempdir().expect("tempdir");
        let skill_dir = temp_dir.path().join("my-skill");
        std::fs::create_dir_all(&skill_dir).expect("mkdir");

        let skill_md_content = "---\nname: my-skill\nversion: 1.0.0\n---\n# Hello";
        let skill_md_path = skill_dir.join("SKILL.md");
        std::fs::write(&skill_md_path, skill_md_content).expect("write skill.md");

        let hash = compute_bytes_sha256(skill_md_content.as_bytes());

        let mut manifest = MarketplaceSkillManifest {
            id: "my-skill".to_string(),
            name: "My Skill".to_string(),
            version: "1.0.0".to_string(),
            description: "Test skill".to_string(),
            author: Some("jeikl".to_string()),
            repository: None,
            min_jeikcode_version: None,
            files: vec![MarketplaceSkillFile {
                relative_path: "SKILL.md".to_string(),
                sha256: hash.clone(),
                size_bytes: skill_md_content.len() as u64,
            }],
            checksum: None,
            tags: vec![],
        };

        // 1. Initial state: UpToDate
        let status = check_skill_update_status(&skill_dir, &manifest);
        assert_eq!(
            status,
            SkillUpdateStatus::UpToDate {
                version: "1.0.0".to_string()
            }
        );
        assert!(verify_skill_integrity(&skill_dir, &manifest).is_ok());

        // 2. New version available in marketplace: 1.1.0
        manifest.version = "1.1.0".to_string();
        let status_update = check_skill_update_status(&skill_dir, &manifest);
        assert_eq!(
            status_update,
            SkillUpdateStatus::UpdateAvailable {
                current_version: "1.0.0".to_string(),
                latest_version: "1.1.0".to_string(),
            }
        );

        // 3. User tampered/modified local file
        manifest.version = "1.0.0".to_string();
        std::fs::write(
            &skill_md_path,
            "---\nname: my-skill\nversion: 1.0.0\n---\n# Modified locally",
        )
        .expect("modify");
        let status_modified = check_skill_update_status(&skill_dir, &manifest);
        assert!(matches!(
            status_modified,
            SkillUpdateStatus::ModifiedLocally { .. }
        ));

        let err = verify_skill_integrity(&skill_dir, &manifest).unwrap_err();
        assert!(matches!(err, SkillIntegrityError::ChecksumMismatch { .. }));

        // 4. Path traversal attempt in manifest files
        let trav_manifest = MarketplaceSkillManifest {
            files: vec![MarketplaceSkillFile {
                relative_path: "../../etc/shadow".to_string(),
                sha256: "0123456789abcdef".to_string(),
                size_bytes: 10,
            }],
            ..manifest.clone()
        };
        let trav_err = verify_skill_integrity(&skill_dir, &trav_manifest).unwrap_err();
        assert!(matches!(trav_err, SkillIntegrityError::InvalidPath(_)));
    }
}
