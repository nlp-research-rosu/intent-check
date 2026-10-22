use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{env, fs, path::PathBuf};

#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    pub server_url: String,
    pub portal_url: String,
    pub request_timeout_seconds: u64,
    pub poll_interval_seconds: u64,
    pub max_run_attempts: u32,
    #[serde(alias = "max_dry_runs", alias = "max_validations")]
    pub max_validation_attempts: u32,
    #[serde(alias = "max_attempts")]
    pub max_proof_attempts: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: "https://prover.intentcomputing.org".into(),
            portal_url: "https://prover-console.intentcomputing.org".into(),
            request_timeout_seconds: 30,
            poll_interval_seconds: 10,
            max_run_attempts: 50,
            max_validation_attempts: 50,
            max_proof_attempts: 50,
        }
    }
}

pub fn load() -> Result<Config> {
    let path = path()?;
    let config = if path.exists() {
        toml::from_str(&fs::read_to_string(path)?)?
    } else {
        Config::default()
    };
    validate(&config)?;
    Ok(config)
}

pub fn view() -> Result<Value> {
    Ok(json!({"configPath": path()?, "config": load()?}))
}

pub fn directory() -> Result<PathBuf> {
    Ok(path()?.parent().unwrap().to_path_buf())
}

fn path() -> Result<PathBuf> {
    if let Some(path) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path).join("prover-client/config.toml"));
    }
    #[cfg(windows)]
    if let Some(path) = env::var_os("APPDATA") {
        return Ok(PathBuf::from(path).join("prover-client/config.toml"));
    }
    let home = env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is not set"))?;
    Ok(PathBuf::from(home).join(".config/prover-client/config.toml"))
}

fn validate(config: &Config) -> Result<()> {
    if config.server_url.trim().is_empty()
        || config.portal_url.trim().is_empty()
        || config.request_timeout_seconds == 0
        || config.poll_interval_seconds == 0
        || config.max_run_attempts == 0
        || config.max_validation_attempts == 0
        || config.max_proof_attempts == 0
    {
        bail!("Prover Client configuration contains an invalid value");
    }
    Ok(())
}
