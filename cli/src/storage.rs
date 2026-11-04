use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
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
            ("README.md", include_str!("../../intent-storage.md")),
            (".gitignore", ".sent.log\n.queue\n.storage.lock\n"),
        ] {
            let path = dir.join(name);
            if !path.exists() {
                fs::write(path, text)?;
            }
        }
    }
    Ok(dir)
}

/// Current formal files and the last applicable operation for one property.
#[derive(Clone, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub specs: Vec<String>,
    pub last_run: Option<uuid::Uuid>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Index {
    pub schema_version: u32,
    pub properties: BTreeMap<uuid::Uuid, Selection>,
}

impl Default for Index {
    fn default() -> Self {
        Self {
            schema_version: 1,
            properties: BTreeMap::new(),
        }
    }
}

pub fn source_dir(root: &Path, source: &str) -> Result<PathBuf> {
    crate::requirements::relative_path(source)?;
    let path = root.join(".intent/source").join(source);
    safe_parent(root, &path)?;
    Ok(path)
}

pub fn read_index(root: &Path, source: &str) -> Result<Index> {
    let file = source_dir(root, source)?.join("index.json");
    safe_parent(root, &file)?;
    if !file.exists() {
        return Ok(Index::default());
    }
    let index: Index = serde_json::from_slice(&fs::read(file)?)?;
    ensure!(
        index.schema_version == 1,
        "Unsupported index schema version"
    );
    for selection in index.properties.values() {
        for spec in &selection.specs {
            spec_path(root, spec)?;
        }
    }
    Ok(index)
}

pub fn write_index(root: &Path, source: &str, index: &Index) -> Result<()> {
    let dir = source_dir(root, source)?;
    fs::create_dir_all(&dir)?;
    crate::api::write_json(&dir, "index.json", &serde_json::to_value(index)?)
}

/// Specification references are relative to .intent, including for cross-file properties.
pub fn spec_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let (source, name) = relative
        .strip_prefix("source/")
        .and_then(|p| p.split_once("/specs/"))
        .context("Expected a per-source specification path")?;
    crate::requirements::relative_path(source)?;
    crate::requirements::relative_path(name)?;
    let file = root.join(".intent").join(relative);
    safe_parent(root, &file)?;
    Ok(file)
}

pub fn indexes(root: &Path) -> Result<Vec<(String, Index)>> {
    fn visit(root: &Path, dir: &Path, out: &mut Vec<(String, Index)>) -> Result<()> {
        if !dir.exists() {
            return Ok(());
        }
        safe_parent(root, dir)?;
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let path = entry.path();
            if path.join("index.json").exists() {
                let source = path
                    .strip_prefix(root.join(".intent/source"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((source.clone(), read_index(root, &source)?));
            } else if !path.join("requirements.json").exists() {
                visit(root, &path, out)?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    visit(root, &root.join(".intent/source"), &mut out)?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    let mut owners = std::collections::BTreeSet::new();
    for (_, index) in &out {
        for id in index.properties.keys() {
            ensure!(
                owners.insert(id),
                "Property has more than one owning index: {id}"
            );
        }
    }
    Ok(out)
}

pub fn lock(root: &Path) -> Result<fs::File> {
    let dir = intent(root, true)?;
    let path = dir.join(".storage.lock");
    safe_parent(root, &path)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    file.lock()?;
    Ok(file)
}

pub fn place_property(
    root: &Path,
    id: &str,
    targets: &[crate::requirements::Target],
) -> Result<()> {
    let id = uuid::Uuid::parse_str(id)?;
    let mut selection = Selection::default();
    let mut owner = None;
    let indexes = indexes(root)?;
    for (source, index) in &indexes {
        if let Some(saved) = index.properties.get(&id) {
            selection = saved.clone();
            if targets.iter().any(|target| target.path == *source) {
                owner = Some(source.clone());
            }
        }
    }
    let owner = owner.unwrap_or_else(|| targets[0].path.clone());
    for (source, mut index) in indexes {
        if source != owner && index.properties.remove(&id).is_some() {
            write_index(root, &source, &index)?;
        }
    }
    let mut index = read_index(root, &owner)?;
    index.properties.insert(id, selection);
    write_index(root, &owner, &index)
}

pub fn remove_property(root: &Path, id: &str) -> Result<()> {
    let id = uuid::Uuid::parse_str(id)?;
    for (source, mut index) in indexes(root)? {
        if index.properties.remove(&id).is_some() {
            write_index(root, &source, &index)?;
        }
    }
    Ok(())
}

/// Internal collection for request construction; agents read project files directly.
pub fn collect(root: &Path, paths: &[String]) -> Result<Value> {
    let docs = crate::requirements::documents(root)?;
    let requirements: Vec<_> = docs
        .iter()
        .flat_map(|(_, _, doc)| &doc.requirements)
        .filter(|r| paths.is_empty() || r.targets.iter().any(|t| paths.contains(&t.path)))
        .collect();
    let mut properties = BTreeMap::new();
    for (source, index) in indexes(root)? {
        for (id, selection) in index.properties {
            if requirements.iter().any(|r| r.id == id.to_string()) {
                let specs: Vec<_> = selection
                    .specs
                    .iter()
                    .map(|path| {
                        let file = spec_path(root, path)?;
                        let text = fs::read_to_string(file).ok();
                        Ok(json!({"path":path,"sha256":text.as_ref().map(hash),"content":text}))
                    })
                    .collect::<Result<_>>()?;
                properties.insert(
                    id,
                    json!({"owner":source,"specs":specs,"last_run":selection.last_run}),
                );
            }
        }
    }
    Ok(
        json!({"schema_version":1,"brief":crate::requirements::brief(root)?,"requirements":requirements,"properties":properties}),
    )
}

/// Freeze the property selection and working versions before submitting an operation.
pub fn property_snapshot(
    root: &Path,
    ids: &[Value],
    inputs: &[(String, Vec<u8>)],
) -> Result<Value> {
    let context = collect(root, &[])?;
    let mut properties = Vec::new();
    for bound in ids {
        let id = bound["id"].as_str().context("Missing property UUID")?;
        let record = context["requirements"]
            .as_array()
            .context("Missing requirements")?
            .iter()
            .find(|r| r["id"] == id)
            .context("Unknown property")?;
        let owner = context["properties"][id]["owner"]
            .as_str()
            .context("Property has no owning index")?;
        let selection = &read_index(root, owner)?.properties[&uuid::Uuid::parse_str(id)?];
        let sources: Vec<_> = record["targets"]
            .as_array()
            .context("Missing targets")?
            .iter()
            .map(|target| {
                let path = target["path"].as_str().context("Missing target path")?;
                Ok(json!({"path":path,"sha256":hash(fs::read(root.join(path))?)}))
            })
            .collect::<Result<_>>()?;
        let mut specs = BTreeMap::new();
        for path in &selection.specs {
            specs.insert(
                path.clone(),
                fs::read(spec_path(root, path)?).ok().map(hash),
            );
        }
        let mut outputs = Vec::new();
        for (name, _) in inputs.iter().filter(|(name, _)| name.ends_with(".k")) {
            let path = format!("source/{owner}/specs/{name}");
            let file = spec_path(root, &path)?;
            specs
                .entry(path.clone())
                .or_insert_with(|| fs::read(file).ok().map(hash));
            outputs.push(json!({"input":name,"path":path}));
        }
        properties.push(json!({"id":id,"owner":owner,"selection":selection,"record_sha256":bound["record_sha256"],"sources":sources,"specs":specs,"outputs":outputs}));
    }
    Ok(json!(properties))
}

/// Promote explicit property-associated formal inputs after a terminal operation.
pub fn finish_properties(root: &Path, evidence: &Path, successful: bool) -> Result<()> {
    let _lock = lock(root)?;
    let request: Value = serde_json::from_slice(&fs::read(evidence.join("request.json"))?)?;
    let run = uuid::Uuid::parse_str(
        evidence
            .file_name()
            .and_then(|s| s.to_str())
            .context("Missing run UUID")?,
    )?;
    let docs = crate::requirements::documents(root)?;
    let mut result: Value = serde_json::from_slice(&fs::read(evidence.join("result.json"))?)?;
    let mut written = BTreeMap::<String, String>::new();
    for property in request["properties"].as_array().into_iter().flatten() {
        let id = uuid::Uuid::parse_str(property["id"].as_str().context("Missing property UUID")?)?;
        let owner = property["owner"].as_str().context("Missing owner")?;
        let mut index = read_index(root, owner)?;
        let Some(selection) = index.properties.get_mut(&id) else {
            continue;
        };
        if selection.last_run == Some(run) {
            continue;
        }
        if serde_json::to_value(&*selection)? != property["selection"] {
            continue;
        }
        let record = docs
            .iter()
            .flat_map(|(_, _, doc)| &doc.requirements)
            .find(|r| r.id == id.to_string());
        if record
            .map(crate::requirements::record_hash)
            .transpose()?
            .as_deref()
            != property["record_sha256"].as_str()
        {
            continue;
        }
        let sources_match = property["sources"].as_array().is_some_and(|sources| {
            !sources.is_empty()
                && sources.iter().all(|source| {
                    source["path"]
                        .as_str()
                        .and_then(|p| fs::read(root.join(p)).ok())
                        .map(hash)
                        .as_deref()
                        == source["sha256"].as_str()
                })
        });
        let specs_match = property["specs"].as_object().is_some_and(|specs| {
            specs.iter().all(|(path, expected)| {
                let actual = spec_path(root, path)
                    .ok()
                    .and_then(|p| fs::read(p).ok())
                    .map(hash);
                actual.as_deref() == expected.as_str()
                    || written
                        .get(path)
                        .is_some_and(|hash| Some(hash) == actual.as_ref())
            })
        });
        let inputs_match = request["inputs"].as_array().is_some_and(|inputs| {
            inputs.iter().all(|input| {
                input["path"]
                    .as_str()
                    .and_then(|path| {
                        let file = root.join(".intent").join(path);
                        safe_parent(root, &file).ok()?;
                        fs::read(file).ok()
                    })
                    .map(hash)
                    .as_deref()
                    == input["sha256"].as_str()
            })
        });
        if !sources_match || !specs_match || !inputs_match {
            continue;
        }
        if successful {
            for output in property["outputs"].as_array().into_iter().flatten() {
                let name = output["input"].as_str().context("Missing formal input")?;
                crate::requirements::relative_path(name)?;
                let bytes = fs::read(evidence.join("inputs").join(name))?;
                let artifact = evidence.join("artifacts").join(name);
                safe_parent(root, &artifact)?;
                fs::create_dir_all(artifact.parent().context("Missing artifact parent")?)?;
                fs::write(artifact, &bytes)?;
                let path = output["path"]
                    .as_str()
                    .context("Missing current specification path")?;
                let file = spec_path(root, path)?;
                fs::create_dir_all(file.parent().context("Missing specification parent")?)?;
                let temporary = file.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
                written.insert(path.into(), hash(&bytes));
                fs::write(&temporary, bytes)?;
                fs::rename(temporary, file)?;
                if !selection.specs.iter().any(|p| p == path) {
                    selection.specs.push(path.into());
                }
            }
            selection.specs.sort();
        }
        selection.last_run = Some(run);
        let current: Vec<_> = selection
            .specs
            .iter()
            .map(|path| {
                Ok(json!({"path":path,"sha256":fs::read(spec_path(root, path)?).ok().map(hash)}))
            })
            .collect::<Result<_>>()?;
        if !result["properties"].is_object() {
            result["properties"] = json!({});
        }
        result["properties"][id.to_string()] = json!({"specs":current});
        crate::api::write_json(evidence, "result.json", &result)?;
        write_index(root, owner, &index)?;
    }
    Ok(())
}
