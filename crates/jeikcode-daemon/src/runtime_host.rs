use std::sync::Arc;

use async_trait::async_trait;
use jeikcode_coding::cc_hooks::HookConfig;
use jeikcode_coding::{PluginHookSource, RateLimitWindow, RateLimitWindowSource};

#[derive(Debug, Default)]
pub struct InstalledPluginHookSource;

impl PluginHookSource for InstalledPluginHookSource {
    fn load(&self) -> Result<Vec<HookConfig>, String> {
        jeikcode_capabilities::plugin::hook_trust::ensure_migrated();
        Ok(
            jeikcode_capabilities::plugin::loader::installed_plugin_cc_hooks()
                .into_iter()
                .filter_map(|hook| {
                    HookConfig::from_plugin_spec(
                        &hook.event,
                        hook.matcher,
                        hook.command,
                        hook.timeout_secs,
                        hook.plugin_root,
                    )
                })
                .collect(),
        )
    }
}

pub fn installed_plugin_hook_source() -> Arc<dyn PluginHookSource> {
    Arc::new(InstalledPluginHookSource)
}

pub fn gather_plugin_skill_dirs() -> Vec<(std::path::PathBuf, String)> {
    let working_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    gather_plugin_skill_dirs_for(&working_dir)
}

pub fn gather_plugin_skill_dirs_for(
    working_dir: &std::path::Path,
) -> Vec<(std::path::PathBuf, String)> {
    jeikcode_capabilities::plugin::loader::installed_plugin_skill_dirs(working_dir)
}

#[derive(Debug, Default)]
struct NoopRateLimitSource;

#[async_trait]
impl RateLimitWindowSource for NoopRateLimitSource {
    fn applies_to(&self, _base_url: &str) -> bool {
        false
    }

    async fn fetch_windows(&self) -> Result<Vec<RateLimitWindow>, String> {
        Ok(Vec::new())
    }
}

pub fn coding_plan_rate_limit_source() -> Arc<dyn RateLimitWindowSource> {
    Arc::new(NoopRateLimitSource)
}

pub fn coding_provider_factory() -> Arc<dyn jeikcode_coding::CodingProviderFactory> {
    Arc::new(jeikcode_coding::DefaultCodingProviderFactory::new(
        jeikcode_auth::JEIKCODE_USER_AGENT,
    ))
}
