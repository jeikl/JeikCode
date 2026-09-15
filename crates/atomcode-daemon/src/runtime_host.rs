use std::sync::Arc;

use async_trait::async_trait;
use atomcode_coding::cc_hooks::HookConfig;
use atomcode_coding::{PluginHookSource, RateLimitWindow, RateLimitWindowSource};

#[derive(Debug, Default)]
pub struct InstalledPluginHookSource;

impl PluginHookSource for InstalledPluginHookSource {
    fn load(&self) -> Result<Vec<HookConfig>, String> {
        atomcode_capabilities::plugin::hook_trust::ensure_migrated();
        Ok(
            atomcode_capabilities::plugin::loader::installed_plugin_cc_hooks()
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
    atomcode_capabilities::plugin::loader::installed_plugin_skill_dirs(working_dir)
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

pub fn coding_provider_factory() -> Arc<dyn atomcode_coding::CodingProviderFactory> {
    Arc::new(atomcode_coding::DefaultCodingProviderFactory::new(
        atomcode_auth::ATOMCODE_USER_AGENT,
    ))
}
