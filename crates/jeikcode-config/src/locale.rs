use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Locale {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "vi-VN")]
    Vi,
    #[serde(rename = "zh_CN")]
    ZhCn,
}

/// Compatibility name for callers referring to the UI language as `Lang`.
pub type Lang = Locale;

impl Locale {
    pub fn is_vi(self) -> bool {
        self == Self::Vi
    }

    pub fn native_name(self) -> &'static str {
        match self {
            Self::En => "English",
            Self::Vi => "Tiếng Việt",
            Self::ZhCn => "简体中文",
        }
    }

    /// Canonical key shared by the daemon and language selectors.
    pub fn language_key(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Vi => "vi-VN",
            Self::ZhCn => "zh-CN",
        }
    }
}

impl<'de> Deserialize<'de> for Locale {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct LocaleVisitor;

        impl<'de> serde::de::Visitor<'de> for LocaleVisitor {
            type Value = Locale;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a locale string like 'en', 'vi-VN', 'zh_CN', 'zh-CN', or 'zh'")
            }

            fn visit_str<E>(self, value: &str) -> Result<Locale, E>
            where
                E: serde::de::Error,
            {
                Locale::from_str(value).map_err(serde::de::Error::custom)
            }
        }

        deserializer.deserialize_str(LocaleVisitor)
    }
}

impl Default for Locale {
    fn default() -> Self {
        Locale::En
    }
}

impl fmt::Display for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Locale::En => write!(f, "en"),
            Locale::Vi => write!(f, "vi-VN"),
            Locale::ZhCn => write!(f, "zh_CN"),
        }
    }
}

impl FromStr for Locale {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let normalized = s.trim().to_ascii_lowercase().replace('-', "_");
        match normalized.as_str() {
            "vi" | "vi_vn" => Ok(Locale::Vi),
            "en" | "english" | "en_us" | "en_gb" | "en_ca" | "en_au" => Ok(Locale::En),
            "zh" | "zh_cn" | "zh_hans" | "chinese" | "简体中文" | "zh_tw" | "zh_hk" | "zh_hant"
            | "繁體中文" => Ok(Locale::ZhCn),
            other => {
                if other.starts_with("en") {
                    Ok(Locale::En)
                } else if other.starts_with("zh") || other.contains("中文") {
                    Ok(Locale::ZhCn)
                } else {
                    Err(format!("unsupported locale: {s}"))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vietnamese_aliases_and_canonical_serialization() {
        for alias in ["vi", "vi-VN", "vi_VN", "vi-vn", "vi_vn", "VI-VN"] {
            assert_eq!(alias.parse::<Lang>().unwrap(), Lang::Vi);
            assert_eq!(
                serde_json::from_str::<Locale>(&format!("\"{alias}\"")).unwrap(),
                Locale::Vi
            );
        }
        assert_eq!(serde_json::to_string(&Locale::Vi).unwrap(), "\"vi-VN\"");
        assert_eq!(Locale::Vi.to_string(), "vi-VN");
        assert_eq!(Locale::Vi.native_name(), "Tiếng Việt");
        assert!(Locale::Vi.is_vi());
        assert!(!Locale::En.is_vi());
        for invalid in ["vi-VN-extra", "vietnamese", "vi_US"] {
            assert!(invalid.parse::<Locale>().is_err());
        }
        for locale in [Locale::En, Locale::Vi, Locale::ZhCn] {
            assert_eq!(locale.to_string().parse::<Locale>().unwrap(), locale);
        }
    }

    #[test]
    fn explicit_language_and_atomic_snapshot_ignore_os_defaults() {
        use crate::i18n;
        let _guard = i18n::test_lock();
        let env = |_: &str| Some("zh_CN.UTF-8".to_string());
        assert_eq!(
            i18n::resolve_initial_locale_with_env(None, None, &env),
            Locale::En
        );
        for locale in [Locale::En, Locale::Vi, Locale::ZhCn] {
            assert_eq!(
                i18n::resolve_initial_locale_with_env(None, Some(locale), &env),
                locale
            );
            i18n::set_locale(locale);
            assert_eq!(i18n::current_locale(), locale);
        }
        assert_eq!(
            i18n::resolve_initial_locale_with_env(Some("vi"), Some(Locale::ZhCn), &env),
            Locale::Vi
        );
    }

    #[test]
    fn display_round_trips_through_from_str() {
        assert_eq!(
            Locale::En.to_string().parse::<Locale>().unwrap(),
            Locale::En
        );
        assert_eq!(
            Locale::ZhCn.to_string().parse::<Locale>().unwrap(),
            Locale::ZhCn
        );
    }

    #[test]
    fn from_str_accepts_common_aliases() {
        assert_eq!("en".parse::<Locale>().unwrap(), Locale::En);
        assert_eq!("English".parse::<Locale>().unwrap(), Locale::En);
        assert_eq!("zh".parse::<Locale>().unwrap(), Locale::ZhCn);
        assert_eq!("zh_CN".parse::<Locale>().unwrap(), Locale::ZhCn);
        assert_eq!("zh-cn".parse::<Locale>().unwrap(), Locale::ZhCn);
        assert_eq!("简体中文".parse::<Locale>().unwrap(), Locale::ZhCn);
        // zh_TW / zh_HK fall back to ZhCn (no separate Traditional variant yet)
        assert_eq!("zh_TW".parse::<Locale>().unwrap(), Locale::ZhCn);
        assert_eq!("zh-tw".parse::<Locale>().unwrap(), Locale::ZhCn);
        assert_eq!("zh_HK".parse::<Locale>().unwrap(), Locale::ZhCn);
        assert_eq!("zh-hk".parse::<Locale>().unwrap(), Locale::ZhCn);
        assert_eq!("繁體中文".parse::<Locale>().unwrap(), Locale::ZhCn);
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert!("fr".parse::<Locale>().is_err());
        assert!("".parse::<Locale>().is_err());
    }

    #[test]
    fn serde_uses_short_keys() {
        let s = serde_json::to_string(&Locale::ZhCn).unwrap();
        assert_eq!(s, r#""zh_CN""#);
        let parsed: Locale = serde_json::from_str(r#""en""#).unwrap();
        assert_eq!(parsed, Locale::En);
        let parsed_hyphen: Locale = serde_json::from_str(r#""zh-CN""#).unwrap();
        assert_eq!(parsed_hyphen, Locale::ZhCn);
        let toml_parsed: toml::Value = toml::from_str(r#"language = "zh-CN""#).unwrap();
        let lang: Option<Locale> = toml_parsed
            .get("language")
            .unwrap()
            .clone()
            .try_into()
            .unwrap();
        assert_eq!(lang, Some(Locale::ZhCn));

        for val in &[
            "zh-CN",
            "zh_CN",
            "zh-cn",
            "zh_cn",
            "ZH-CN",
            "ZH_CN",
            "zh",
            "ZH",
            "简体中文",
            "zh-TW",
            "zh_TW",
        ] {
            let toml_doc: toml::Value = toml::from_str(&format!(r#"language = "{val}""#)).unwrap();
            let parsed_lang: Option<Locale> = toml_doc
                .get("language")
                .unwrap()
                .clone()
                .try_into()
                .unwrap();
            assert_eq!(parsed_lang, Some(Locale::ZhCn), "failed for {val}");
        }

        for val in &[
            "en", "EN", "en-US", "en_US", "en-us", "en_us", "English", "english",
        ] {
            let toml_doc: toml::Value = toml::from_str(&format!(r#"language = "{val}""#)).unwrap();
            let parsed_lang: Option<Locale> = toml_doc
                .get("language")
                .unwrap()
                .clone()
                .try_into()
                .unwrap();
            assert_eq!(parsed_lang, Some(Locale::En), "failed for {val}");
        }
    }
}
