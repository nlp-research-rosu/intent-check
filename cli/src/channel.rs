use serde::Deserialize;
use std::{collections::BTreeMap, sync::LazyLock};

#[derive(Debug, Deserialize)]
pub struct Channel<'a> {
    pub display_name: &'a str,
    pub plugin: &'a str,
    pub marketplace: &'a str,
    pub cli: &'a str,
    pub config_dir: &'a str,
    pub api_url: &'a str,
    pub console_url: &'a str,
    pub env_prefix: &'a str,
}

// Both files are embedded: renaming the installed executable cannot change its channel.
pub const NAME: &str = include_str!("../../release/channel");
static CHANNELS: LazyLock<BTreeMap<&str, Channel<'static>>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../release/channels.json"))
        .expect("release/channels.json must define valid release channels")
});

pub fn settings() -> &'static Channel<'static> {
    CHANNELS
        .get(NAME.trim())
        .expect("release/channel must select a defined release channel")
}

pub fn env_name(suffix: &str) -> String {
    format!("{}_{suffix}", settings().env_prefix)
}

// Render shared help copy, not source code or user-provided evidence.
pub fn help(text: &str) -> String {
    let production = &CHANNELS["production"];
    let selected = settings();
    text.replace(production.cli, selected.cli)
        .replace(production.display_name, selected.display_name)
        .replace(production.api_url, selected.api_url)
        .replace(production.console_url, selected.console_url)
        .replace("INTENT_API_URL", &env_name("API_URL"))
        .replace("INTENT_CONSOLE_URL", &env_name("CONSOLE_URL"))
        .replace("INTENT_API_KEY", &env_name("API_KEY"))
        .replace(
            "Production server and portal URLs",
            "This release channel's server and portal URLs",
        )
}
