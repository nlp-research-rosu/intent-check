use anyhow::{Result, bail};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub fn load(root: &Path, paths: &[PathBuf]) -> Result<BTreeMap<String, Vec<u8>>> {
    paths
        .iter()
        .map(|path| {
            let (file, name) = resolve_proof(root, path)?;
            Ok((name, fs::read(file)?))
        })
        .collect()
}

pub fn resolve(root: &Path, source: &Path) -> Result<(PathBuf, String)> {
    let candidate = root.join(source);
    if !candidate.is_file() {
        bail!("K source does not exist: {}", candidate.display());
    }
    let file = candidate.canonicalize()?;
    let relative = file
        .strip_prefix(root)
        .map_err(|_| anyhow::anyhow!("K source escapes candidate directory: {}", file.display()))?;
    let name = relative.to_string_lossy().replace('\\', "/");
    Ok((file, name))
}

pub fn resolve_proof(root: &Path, source: &Path) -> Result<(PathBuf, String)> {
    let (file, _) = resolve(root, source)?;
    let relative = file.strip_prefix(root.join("inputs")).map_err(|_| {
        anyhow::anyhow!(
            "K source escapes session inputs directory: {}",
            file.display()
        )
    })?;
    let name = relative.to_string_lossy().replace('\\', "/");
    Ok((file, name))
}
