use super::{t_with, ConfigSyncChange, Locale, Msg};

#[test]
fn terminal_messages_cover_all_locales_and_preserve_data() {
    for locale in [Locale::En, Locale::Vi, Locale::ZhCn] {
        for msg in [
            Msg::SessionShared,
            Msg::SessionModelRequired,
            Msg::ConfigSyncIntroduction,
            Msg::ConfigSyncUnchanged { skipped: true },
            Msg::ConfigSyncUnchanged { skipped: false },
            Msg::ServerServiceTableHeader,
            Msg::ServerNoServices,
        ] {
            assert!(!t_with(locale, msg).trim().is_empty(), "{locale}: {msg:?}");
        }
        for change in [
            ConfigSyncChange::New,
            ConfigSyncChange::Modified,
            ConfigSyncChange::Obsolete,
        ] {
            for description in [
                "custom/模型/skills/raw-model-v1.toml",
                r"C:\custom\models\raw-model-v1.toml",
            ] {
                let text = t_with(
                    locale,
                    Msg::ConfigSyncStatus {
                        change,
                        description,
                    },
                );
                assert!(text.starts_with(description));
                assert!(text.len() > description.len());
                assert_eq!(text.matches(description).count(), 1);
            }
        }
        let model_notice = t_with(locale, Msg::SessionModelRequired);
        assert!(model_notice.contains("/model"));
        assert!(model_notice.contains("/provider"));
        let introduction = t_with(locale, Msg::ConfigSyncIntroduction);
        for key in ["MCP", "skills", "[a]", "[Enter]", "[ESC]"] {
            assert!(introduction.contains(key), "{locale}: {key}");
        }
        assert!(!introduction.contains("[q]"));
    }
}

#[test]
fn terminal_language_aliases_select_the_same_catalog() {
    for (locale, aliases) in [
        (Locale::En, &["en", "EN", "en-US", "en_GB", "English"][..]),
        (Locale::Vi, &["vi", "vi-VN", "vi_VN", "VI-VN"][..]),
        (
            Locale::ZhCn,
            &["zh", "zh-CN", "zh_CN", "ZH-HANS", "简体中文"][..],
        ),
    ] {
        for alias in aliases {
            let parsed = alias.parse::<Locale>().unwrap();
            assert_eq!(parsed, locale);
            assert_eq!(
                t_with(parsed, Msg::SessionShared),
                t_with(locale, Msg::SessionShared)
            );
        }
    }
}
