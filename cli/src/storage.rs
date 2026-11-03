use anyhow::{Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes.as_ref())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn safe_parent(root: &Path, file: &Path) -> Result<()> {
    let base = root.join(".intent");
    let relative = file.strip_prefix(&base)?;
    let mut current = base;
    for part in relative.components() {
        ensure!(
            matches!(part, std::path::Component::Normal(_)),
            "Unsafe evidence path"
        );
        current.push(part);
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            ensure!(!metadata.is_symlink(), "Evidence must not follow symlinks");
        }
    }
    Ok(())
}

pub fn intent(root: &Path, create: bool) -> Result<PathBuf> {
    let dir = root.join(".intent");
    if let Ok(metadata) = fs::symlink_metadata(&dir) {
        ensure!(
            metadata.is_dir() && !metadata.is_symlink(),
            ".intent must be a real directory"
        );
    }
    if create {
        fs::create_dir_all(&dir)?;
        for (name, text) in [
            ("REQUIREMENTS.md", crate::requirements::BRIEF),
            (".ignore", "*\n"),
            (".gitignore", ".sent.log\n.queue\n"),
        ] {
            let path = dir.join(name);
            if !path.exists() {
                fs::write(path, text)?;
            }
        }
    }
    Ok(dir)
}
