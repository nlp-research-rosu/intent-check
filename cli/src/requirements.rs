use crate::{CommandResult, api, session};
use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

pub const BRIEF: &str = "# Project requirements\n\n## Purpose\n\n## Expected behavior\n\n## Constraints\n\n## Out of scope\n\n## Open questions\n";

#[derive(Subcommand)]
pub enum Command {
    /// List validated requirements from every scope, or one source file.
    List {
        #[arg(long)]
        file: Option<String>,
    },
    /// Show a requirement by its stable ID.
    Show { id: String },
    /// Add a requirement from JSON (statement, targets, optional reason); derive storage from targets.
    Add {
        #[arg(long)]
        input: PathBuf,
    },
    /// Replace a requirement's content, retaining its ID and relocating it if targets change.
    Update {
        id: String,
        #[arg(long)]
        input: PathBuf,
    },
    /// Remove a requirement; this never removes check or proof evidence.
    Remove { id: String },
    /// Read the project brief and applicable structured requirements for local agents/hooks.
    Context {
        #[arg(long)]
        path: Vec<String>,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub statement: String,
    pub targets: Vec<Target>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    pub statement: String,
    pub targets: Vec<Target>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub schema_version: u32,
    pub requirements: Vec<Requirement>,
}

pub fn record_hash(record: &Requirement) -> Result<String> {
    Ok(crate::storage::hash(serde_json::to_vec(
        &serde_json::to_value(record)?,
    )?))
}

pub fn relative_path(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 1024
            && !value.contains(['\\', ':'])
            && !value.chars().any(char::is_control),
        "Invalid source path"
    );
    ensure!(
        value
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
            && !matches!(value.split('/').next(), Some(".git" | ".intent")),
        "Expected an exact repository-relative source path"
    );
    Ok(())
}

fn nonempty(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= 32_768,
        "Requirement text must be nonempty and at most 32768 bytes"
    );
    Ok(())
}

fn source_scope(targets: &[Target]) -> Option<&str> {
    let first = &targets.first()?.path;
    targets
        .iter()
        .all(|target| &target.path == first)
        .then_some(first.as_str())
}

fn validate(content: &Content) -> Result<()> {
    nonempty(&content.statement)?;
    if let Some(reason) = &content.reason {
        nonempty(reason)?;
    }
    ensure!(
        !content.targets.is_empty(),
        "A requirement needs at least one target"
    );
    let mut seen = BTreeSet::new();
    for target in &content.targets {
        relative_path(&target.path)?;
        if let Some(symbol) = &target.symbol {
            nonempty(symbol)?;
            ensure!(
                !symbol.chars().any(char::is_control),
                "Invalid function symbol"
            );
        }
        ensure!(
            seen.insert(serde_json::to_string(target)?),
            "Duplicate requirement target"
        );
    }
    Ok(())
}

fn validate_sources(root: &Path, content: &Content) -> Result<()> {
    for target in &content.targets {
        let file = root
            .join(&target.path)
            .canonicalize()
            .context("Requirement target does not exist")?;
        ensure!(
            file.starts_with(root) && file.is_file(),
            "Requirement target must be a source file inside the project"
        );
    }
    Ok(())
}

impl Requirement {
    fn content(&self) -> Content {
        Content {
            statement: self.statement.clone(),
            targets: self.targets.clone(),
            reason: self.reason.clone(),
        }
    }
    fn new(id: String, content: Content) -> Self {
        Self {
            id,
            statement: content.statement,
            targets: content.targets,
            reason: content.reason,
        }
    }
}

pub fn read_document(path: &Path, local: Option<&str>) -> Result<Document> {
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "Requirements must be regular files"
    );
    ensure!(
        fs::metadata(path)?.len() <= 1024 * 1024,
        "Requirements file exceeds 1 MiB"
    );
    let bytes = fs::read(path)?;
    let doc: Document = serde_json::from_slice(&bytes)
        .with_context(|| format!("Invalid requirements: {}", path.display()))?;
    ensure!(
        doc.schema_version == 1,
        "Unsupported requirements schema version"
    );
    let mut ids = BTreeSet::new();
    for record in &doc.requirements {
        id_number(&record.id)?;
        ensure!(ids.insert(&record.id), "Duplicate requirement ID");
        validate(&record.content())?;
        ensure!(
            source_scope(&record.targets) == local,
            "Requirement placement must match its targets: one source file under files/<source-path>, multiple source files in files/requirements.json"
        );
    }
    Ok(doc)
}

fn write_document(path: &Path, doc: &Document) -> Result<()> {
    let value = serde_json::to_value(doc)?;
    ensure!(
        serde_json::to_vec_pretty(&value)?.len() <= 1024 * 1024,
        "Requirements file exceeds 1 MiB"
    );
    api::write_json(
        path.parent().context("Requirements path has no parent")?,
        "requirements.json",
        &value,
    )
}

fn id_number(id: &str) -> Result<u64> {
    let suffix = id.strip_prefix("REQ-").context("Invalid requirement ID")?;
    ensure!(
        suffix.len() >= 3 && suffix.bytes().all(|b| b.is_ascii_digit()),
        "Invalid requirement ID"
    );
    let number: u64 = suffix.parse().context("Invalid requirement ID")?;
    ensure!(
        number > 0 && id == format!("REQ-{number:03}"),
        "Invalid requirement ID"
    );
    Ok(number)
}

fn store_record(
    root: &Path,
    docs: &mut Vec<(PathBuf, Option<String>, Document)>,
    record: Requirement,
) -> Result<()> {
    let local = source_scope(&record.targets).map(str::to_owned);
    let target = local.as_ref().map_or_else(
        || root.join(".intent/files/requirements.json"),
        |path| {
            root.join(".intent/files")
                .join(path)
                .join("requirements.json")
        },
    );
    let previous = docs
        .iter()
        .position(|(_, _, doc)| doc.requirements.iter().any(|r| r.id == record.id));
    let destination = match docs.iter().position(|(path, _, _)| path == &target) {
        Some(index) => index,
        None => {
            docs.push((
                target.clone(),
                local,
                Document {
                    schema_version: 1,
                    requirements: Vec::new(),
                },
            ));
            docs.len() - 1
        }
    };
    let doc = &mut docs[destination].2;
    doc.requirements.retain(|r| r.id != record.id);
    doc.requirements.push(record.clone());
    crate::storage::intent(root, true)?;
    crate::storage::safe_parent(root, &target)?;
    fs::create_dir_all(target.parent().context("Requirements path has no parent")?)?;
    write_document(&target, doc)?;
    if let Some(index) = previous.filter(|index| *index != destination) {
        let (path, _, doc) = &mut docs[index];
        doc.requirements.retain(|r| r.id != record.id);
        write_document(path, doc)?;
    }
    Ok(())
}

fn collect(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(PathBuf, Option<String>, Document)>,
) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        ensure!(
            !entry.file_type()?.is_symlink(),
            "Source requirement folders must not contain symlinks"
        );
        if entry.file_type()?.is_dir() {
            let file = entry.path().join("requirements.json");
            if file.exists() {
                let local = entry
                    .path()
                    .strip_prefix(root.join(".intent/files"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                relative_path(&local)?;
                out.push((
                    file.clone(),
                    Some(local.clone()),
                    read_document(&file, Some(&local))?,
                ));
            }
            collect(root, &entry.path(), out)?;
        }
    }
    Ok(())
}

pub fn documents(root: &Path) -> Result<Vec<(PathBuf, Option<String>, Document)>> {
    crate::storage::intent(root, false)?;
    crate::storage::safe_parent(root, &root.join(".intent/files"))?;
    let mut docs = Vec::new();
    let file = root.join(".intent/files/requirements.json");
    if file.exists() {
        docs.push((file.clone(), None, read_document(&file, None)?));
    }
    collect(root, &root.join(".intent/files"), &mut docs)?;
    for (file, _, _) in &docs {
        crate::storage::safe_parent(root, file)?;
    }
    docs.sort_by(|a, b| a.0.cmp(&b.0));
    let mut ids = BTreeSet::new();
    for (_, _, doc) in &docs {
        for record in &doc.requirements {
            ensure!(
                ids.insert(&record.id),
                "Requirement IDs must be unique across scopes"
            );
        }
    }
    Ok(docs)
}

pub fn brief(root: &Path) -> Result<Option<String>> {
    let file = root.join(".intent/REQUIREMENTS.md");
    if !file.exists() {
        return Ok(None);
    }
    ensure!(
        fs::symlink_metadata(&file)?.is_file(),
        "Project brief must be a regular file"
    );
    ensure!(
        fs::metadata(&file)?.len() <= 1024 * 1024,
        "Project brief exceeds 1 MiB"
    );
    Ok(Some(fs::read_to_string(file)?))
}

pub(crate) fn context(root: &Path, paths: &[String]) -> Result<serde_json::Value> {
    for path in paths {
        relative_path(path)?;
    }
    let docs = documents(root)?;
    let records: Vec<_> = docs
        .iter()
        .flat_map(|(_, _, doc)| &doc.requirements)
        .filter(|record| {
            paths.is_empty()
                || record
                    .targets
                    .iter()
                    .any(|target| paths.contains(&target.path))
        })
        .collect();
    Ok(json!({"schema_version":1,"brief":brief(root)?,"requirements":records}))
}

pub fn dispatch(command: Command) -> CommandResult {
    let root = session::project_root(&std::env::current_dir()?)?;
    let mut docs = documents(&root)?;
    match command {
        Command::List { file } => {
            if let Some(path) = &file {
                relative_path(path)?;
            }
            let requirements: Vec<_> = docs
                .iter()
                .flat_map(|(_, _, doc)| &doc.requirements)
                .filter(|r| {
                    file.as_ref()
                        .is_none_or(|path| r.targets.iter().any(|t| &t.path == path))
                })
                .collect();
            Ok((0, json!({"schema_version":1,"requirements":requirements})))
        }
        Command::Context { path } => {
            for source in &path {
                relative_path(source)?;
            }
            let requirements: Vec<_> = docs
                .iter()
                .flat_map(|(_, _, doc)| &doc.requirements)
                .filter(|r| path.is_empty() || r.targets.iter().any(|t| path.contains(&t.path)))
                .collect();
            Ok((
                0,
                json!({"schema_version":1,"brief":brief(&root)?,"requirements":requirements}),
            ))
        }
        Command::Show { id } => {
            let record = docs
                .iter()
                .flat_map(|(_, _, doc)| &doc.requirements)
                .find(|r| r.id == id)
                .context("Unknown requirement ID")?;
            Ok((0, json!({"requirement":record})))
        }
        Command::Add { input } => {
            let content: Content = serde_json::from_slice(&fs::read(input)?)?;
            validate(&content)?;
            validate_sources(&root, &content)?;
            let next = docs
                .iter()
                .flat_map(|(_, _, doc)| &doc.requirements)
                .map(|r| id_number(&r.id))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .max()
                .unwrap_or(0)
                .checked_add(1)
                .context("Requirement ID limit reached")?;
            let id = format!("REQ-{next:03}");
            let record = Requirement::new(id, content);
            store_record(&root, &mut docs, record.clone())?;
            Ok((0, json!({"requirement":record})))
        }
        Command::Update { id, input } => {
            ensure!(
                docs.iter()
                    .any(|(_, _, doc)| doc.requirements.iter().any(|r| r.id == id)),
                "Unknown requirement ID"
            );
            let content: Content = serde_json::from_slice(&fs::read(input)?)?;
            validate(&content)?;
            validate_sources(&root, &content)?;
            let record = Requirement::new(id.clone(), content);
            store_record(&root, &mut docs, record.clone())?;
            Ok((0, json!({"requirement":record})))
        }
        Command::Remove { id } => {
            let (path, _, doc) = docs
                .iter_mut()
                .find(|(_, _, doc)| doc.requirements.iter().any(|r| r.id == id))
                .context("Unknown requirement ID")?;
            doc.requirements.retain(|r| r.id != id);
            write_document(path, doc)?;
            Ok((0, json!({"removed":id})))
        }
    }
}
