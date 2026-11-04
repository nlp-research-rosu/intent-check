use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, env, fs, path::PathBuf};

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
    pub lsp: BTreeMap<String, crate::lsp::ServerConfig>,
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
            lsp: BTreeMap::new(),
        }
    }
}

pub fn load() -> Result<Config> {
    let path = path()?;
    let mut config: Config = if path.exists() {
        toml::from_str(&fs::read_to_string(path)?)?
    } else {
        Config::default()
    };
    // Same variables as the plugin, so both talk to the same service.
    for (name, field) in [
        ("INTENT_API_URL", &mut config.server_url),
        ("INTENT_CONSOLE_URL", &mut config.portal_url),
    ] {
        if let Ok(url) = env::var(name)
            && !url.trim().is_empty()
        {
            *field = url.trim().into();
        }
    }
    config.server_url = config.server_url.trim().trim_end_matches('/').into();
    config.portal_url = config.portal_url.trim().trim_end_matches('/').into();
    validate(&config)?;
    Ok(config)
}

pub fn view() -> Result<Value> {
    Ok(json!({"configPath": path()?, "config": load()?}))
}

pub fn directory() -> Result<PathBuf> {
    let (old, new) = directories()?;
    ensure!(
        legacy_entries(&old)?.is_empty(),
        "Existing Intent Check state at {}; run intent-prover migrate before continuing",
        old.display()
    );
    Ok(new)
}

fn path() -> Result<PathBuf> {
    Ok(directory()?.join("config.toml"))
}

fn directories() -> Result<(PathBuf, PathBuf)> {
    let base = if let Some(path) = env::var_os("XDG_CONFIG_HOME") {
        PathBuf::from(path)
    } else {
        default_directory()?
    };
    Ok((base.join("intent-check"), base.join("intent-prover")))
}

fn default_directory() -> Result<PathBuf> {
    #[cfg(windows)]
    if let Some(path) = env::var_os("APPDATA") {
        return Ok(PathBuf::from(path));
    }
    let home = env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is not set"))?;
    Ok(PathBuf::from(home).join(".config"))
}

fn legacy_entries(directory: &std::path::Path) -> Result<Vec<fs::DirEntry>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    // Existing shell profiles can still source these PATH-only files.
    Ok(fs::read_dir(directory)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|entry| entry.file_name() != "env" && entry.file_name() != "env.fish")
        .collect())
}

pub fn migrate() -> Result<Value> {
    let (old, new) = directories()?;
    let entries = legacy_entries(&old)?;
    for entry in &entries {
        let target = new.join(entry.file_name());
        ensure!(
            !target.try_exists()?,
            "Migration conflict at {}; no files were moved. Resolve the two installations before retrying",
            target.display()
        );
    }
    if !entries.is_empty() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&new)?;
        for entry in &entries {
            fs::rename(entry.path(), new.join(entry.file_name()))
                .context("Migration stopped; existing files are preserved. Run intent-prover migrate to continue")?;
        }
    }
    load()?;
    crate::auth::validate_saved_credentials()?;
    Ok(json!({"status":"ready", "configPath":path()?, "migratedEntries":entries.len()}))
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
        bail!("intent-prover configuration contains an invalid value");
    }
    Ok(())
}
