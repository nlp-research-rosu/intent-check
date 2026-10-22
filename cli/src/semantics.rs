use crate::{api::Api, config, session};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Identity {
    pub id: String,
    pub commit: String,
}

fn validate_identity(identity: &Identity) -> Result<()> {
    ensure!(
        identity.id.split('-').all(|part| !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())),
        "Invalid semantics ID"
    );
    ensure!(
        identity.commit.len() == 12
            && identity
                .commit
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Expected a 12-character semantics commit"
    );
    Ok(())
}

pub fn source_dir(identity: &Identity) -> Result<PathBuf> {
    validate_identity(identity)?;
    Ok(config::directory()?
        .join("semantics")
        .join(&identity.id)
        .join(&identity.commit))
}

pub fn select(id: &str, config: &config::Config) -> Result<Identity> {
    let api = Api::new(config)?;
    let catalog = api.semantics()?;
    let identities: Vec<Identity> = serde_json::from_value(catalog["semantics"].clone())?;
    let identity = identities
        .into_iter()
        .find(|entry| entry.id == id)
        .context("Unknown semantics ID")?;
    let source = source_dir(&identity)?;
    download(&identity, &source, || api.semantics_archive(id))?;
    Ok(identity)
}

fn archive(input: impl Read + Seek, identity: &Identity, staging: &Path) -> Result<PathBuf> {
    validate_identity(identity)?;
    let mut archive = zip::ZipArchive::new(input).context("Invalid semantics ZIP archive")?;
    let root_name = format!("{}_{}", identity.id, identity.commit);
    ensure!(!archive.is_empty(), "Empty semantics archive");
    let mut has_files = false;
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        has_files |= entry.is_file();
        let name = entry.name()?;
        let path = Path::new(name.as_ref());
        ensure!(
            !name.contains('\\') && path.components().all(|c| matches!(c, Component::Normal(_))),
            "Unsafe path in semantics archive"
        );
        ensure!(
            path.components().next() == Some(Component::Normal(root_name.as_ref())),
            "Semantics archive revision does not match the catalog; fetch again"
        );
        ensure!(
            matches!(
                entry.unix_mode().unwrap_or(0) & 0o170000,
                0 | 0o100000 | 0o040000
            ),
            "Unsupported entry in semantics archive"
        );
    }
    ensure!(has_files, "Semantics archive contains no source files");
    archive.extract(staging)?;
    let root = staging.join(root_name);
    ensure!(root.is_dir(), "Semantics archive root is not a directory");
    Ok(root)
}

fn download(
    identity: &Identity,
    source: &Path,
    request: impl FnOnce() -> Result<reqwest::blocking::Response>,
) -> Result<()> {
    let parent = source.parent().context("Invalid semantics cache path")?;
    fs::create_dir_all(parent)?;
    let _lock = session::lock(parent)?;
    if !source.exists() {
        let staging = parent.join(format!(".download-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging)?;
        let result = (|| -> Result<()> {
            // Stream to disk: archives can be too large to buffer in memory.
            let mut response = request()?;
            let mut zip = fs::File::create(staging.join("sources.zip"))?;
            std::io::copy(&mut response, &mut zip)?;
            drop(zip);
            let ready = archive(
                fs::File::open(staging.join("sources.zip"))?,
                identity,
                &staging,
            )?;
            fs::rename(ready, source).context("Could not cache semantics")
        })();
        let _ = fs::remove_dir_all(&staging);
        result?;
    }
    Ok(())
}

pub fn fetch(id: &str) -> Result<Value> {
    let identity = select(id, &config::load()?)?;
    let source = source_dir(&identity)?;
    Ok(
        json!({"status": "ready", "semantics": identity, "sourceDir": source,
        "entryFile": source.join("semantics.k").is_file().then(|| source.join("semantics.k"))}),
    )
}

pub fn require(identity: &Identity, requested: Option<&str>) -> Result<()> {
    if let Some(id) = requested {
        ensure!(
            id == identity.id,
            "--semantics differs from the session selection"
        );
    }
    Ok(())
}
