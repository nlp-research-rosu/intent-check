mod client;

use crate::{api, config, storage};
use anyhow::{Context, Result, ensure};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    time::Instant,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub command: Vec<String>,
    pub extensions: Vec<String>,
    pub language_id: String,
    pub root_markers: Vec<String>,
    pub disabled: bool,
    pub env: BTreeMap<String, String>,
    pub initialization: Value,
    pub settings: Value,
}

impl ServerConfig {
    pub fn validate(&self, name: &str) -> Result<()> {
        if self.disabled {
            return Ok(());
        }
        ensure!(!name.trim().is_empty(), "LSP server name must not be empty");
        ensure!(
            self.command.first().is_some_and(|s| !s.trim().is_empty())
                && !self.language_id.trim().is_empty()
                && !self.extensions.is_empty(),
            "LSP {name} requires command, language_id and extensions"
        );
        ensure!(
            self.extensions
                .iter()
                .all(|s| s.starts_with('.') && s.len() > 1 && !s.contains(['/', '\\'])),
            "LSP {name} extensions must be suffixes such as .py"
        );
        ensure!(
            self.root_markers.iter().all(|s| !s.is_empty()
                && Path::new(s).components().count() == 1
                && matches!(
                    Path::new(s).components().next(),
                    Some(std::path::Component::Normal(_))
                )),
            "LSP {name} root_markers must be file or directory names"
        );
        ensure!(
            self.settings.is_null() || self.settings.is_object(),
            "LSP {name} settings must be a table"
        );
        Ok(())
    }

    fn matches(&self, path: &Path) -> bool {
        !self.disabled
            && path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| self.extensions.iter().any(|s| s == &format!(".{ext}")))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct Position {
    line: u32,
    character: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Range {
    start: Position,
    end: Position,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    name: String,
    kind: u32,
    uri: String,
    range: Range,
    selection_range: Range,
}

#[derive(Debug)]
struct Node {
    path: String,
    name: String,
    kind: SymbolKind,
    range: Range,
    position: Position,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SymbolKind {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Method,
    Property,
    Field,
    Constructor,
    Enum,
    Interface,
    Function,
    Variable,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

impl SymbolKind {
    fn from_lsp(kind: u32) -> Option<Self> {
        match kind {
            1 => Some(Self::File),
            2 => Some(Self::Module),
            3 => Some(Self::Namespace),
            4 => Some(Self::Package),
            5 => Some(Self::Class),
            6 => Some(Self::Method),
            7 => Some(Self::Property),
            8 => Some(Self::Field),
            9 => Some(Self::Constructor),
            10 => Some(Self::Enum),
            11 => Some(Self::Interface),
            12 => Some(Self::Function),
            13 => Some(Self::Variable),
            14 => Some(Self::Constant),
            15 => Some(Self::String),
            16 => Some(Self::Number),
            17 => Some(Self::Boolean),
            18 => Some(Self::Array),
            19 => Some(Self::Object),
            20 => Some(Self::Key),
            21 => Some(Self::Null),
            22 => Some(Self::EnumMember),
            23 => Some(Self::Struct),
            24 => Some(Self::Event),
            25 => Some(Self::Operator),
            26 => Some(Self::TypeParameter),
            _ => None,
        }
    }

    fn callable(self) -> bool {
        matches!(
            self,
            Self::Class | Self::Method | Self::Constructor | Self::Function
        )
    }
}

#[derive(Debug)]
struct Usage {
    target: String,
    path: String,
    range: Range,
}

#[derive(Debug)]
struct Relationship {
    from: String,
    to: String,
    path: String,
    range: Range,
}

#[derive(Serialize)]
struct Symbol {
    name: String,
    kind: SymbolKind,
    file: String,
    line: u32,
    end_line: u32,
}

#[derive(Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct Call {
    caller: String,
    callee: String,
    file: String,
    line: u32,
}

#[derive(Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct Reference {
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    to: String,
    file: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Default)]
struct Graph {
    nodes: BTreeMap<String, Node>,
    relationships: BTreeMap<String, Relationship>,
    usages: Vec<Usage>,
    completed_files: BTreeSet<String>,
    issues: Vec<Value>,
    omitted_symbols: Vec<Value>,
    omitted_external: usize,
}

/// Refresh local symbol context for native hooks; never calls the prover or prints host output.
pub(crate) fn refresh(
    root: &Path,
    servers: &BTreeMap<String, ServerConfig>,
    interrupted: fn() -> bool,
) -> Result<Value> {
    if !servers.values().any(|server| !server.disabled) {
        return Ok(json!({"status":"skipped", "reason":"unconfigured"}));
    }
    for (name, config) in servers {
        config.validate(name)?;
    }
    let root = crate::session::project_root(root)?;
    // A shared project lock prevents Claude and Codex from collecting the same graph concurrently.
    let locks = config::directory()?.join("lsp");
    fs::create_dir_all(&locks)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(locks.join(format!(
            "{}.lock",
            storage::hash(root.to_string_lossy().as_bytes())
        )))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            return Ok(json!({"status":"skipped", "reason":"collection_in_progress"}));
        }
        Err(fs::TryLockError::Error(error)) => return Err(error.into()),
    }
    let state = locks.join("state");
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&state)?;
    let files = discover(&root)?;
    collect(&root, &files, servers, &state, interrupted)
}

fn collect(
    root: &Path,
    files: &[PathBuf],
    servers: &BTreeMap<String, ServerConfig>,
    state: &Path,
    interrupted: fn() -> bool,
) -> Result<Value> {
    let started = Instant::now();
    let mut groups = BTreeMap::<(String, PathBuf), Vec<PathBuf>>::new();
    let mut sources = BTreeMap::<String, String>::new();
    for file in files {
        for (name, config) in servers.iter().filter(|(_, s)| s.matches(file)) {
            sources.insert(relative(root, file)?, storage::hash(fs::read(file)?));
            groups
                .entry((name.clone(), server_root(root, file, config)))
                .or_default()
                .push(file.clone());
        }
    }
    if groups.is_empty() {
        return Ok(json!({"status":"skipped", "reason":"no_matching_sources"}));
    }
    let mut project_configs = BTreeMap::new();
    for (name, directory) in groups.keys() {
        let config = &servers[name];
        // Keep project configuration hashes alongside source hashes without copying its contents.
        for marker in &config.root_markers {
            let file = directory.join(marker);
            if file.is_file() {
                project_configs.insert(relative(root, &file)?, storage::hash(fs::read(file)?));
            }
        }
    }
    let fingerprint = json!({"format_version":3,"sources":sources,"project_configs":project_configs,
        "lsp_config_sha256":storage::hash(serde_json::to_vec(servers)?)});
    let state_name = format!("{}.json", storage::hash(root.to_string_lossy().as_bytes()));
    let previous = fs::read(state.join(&state_name))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    let directory = storage::intent(root, false)?;
    storage::safe_parent(root, &directory.join("graph.json"))?;
    if previous["complete"] == true
        && previous["fingerprint"] == fingerprint
        && fs::read(directory.join("graph.json"))
            .is_ok_and(|bytes| previous["graph_sha256"] == storage::hash(bytes))
    {
        return Ok(json!({"status":"unchanged"}));
    }
    let mut graph = Graph::default();
    let mut analyzers = Vec::new();
    for ((name, directory), selected) in &groups {
        ensure!(
            !interrupted(),
            "LSP collection interrupted; previous graph preserved"
        );
        let config = &servers[name];
        let result = collect_server(
            root,
            directory,
            selected,
            config,
            &sources,
            &mut graph,
            interrupted,
        );
        match result {
            Ok(info) => analyzers.push(json!({"server":name, "root":relative(root, directory)?, "server_info":info})),
            Err(error) => graph.issues.push(json!({"server":name, "root":relative(root, directory)?, "message":format!("{error:#}")})),
        }
    }
    ensure!(
        !interrupted(),
        "LSP collection interrupted; previous graph preserved"
    );
    ensure!(
        !graph.completed_files.is_empty(),
        "No files completed LSP collection; previous graph preserved. Issues: {}",
        serde_json::to_string(&graph.issues)?
    );
    let current_files = discover(root)?;
    let current_sources: BTreeMap<_, _> = current_files
        .iter()
        .filter(|f| servers.values().any(|s| s.matches(f)))
        .map(|file| Ok((relative(root, file)?, storage::hash(fs::read(file)?))))
        .collect::<Result<_>>()?;
    ensure!(
        sources == current_sources,
        "Source files changed during collection; previous graph preserved"
    );
    for (path, hash) in &project_configs {
        ensure!(
            storage::hash(fs::read(root.join(path))?) == *hash,
            "Project config changed during collection; previous graph preserved"
        );
    }
    let complete = graph.issues.is_empty();
    let mut value = graph.readable();
    if !complete {
        value["status"] = json!("partial");
        value["issues"] = json!(graph.issues);
    }
    let directory = storage::intent(root, true)?;
    storage::safe_parent(root, &directory.join("graph.json"))?;
    api::write_json(&directory, "graph.json", &value)?;
    api::write_json(
        state,
        &state_name,
        &json!({
            "complete":complete,"fingerprint":fingerprint,
            "graph_sha256":storage::hash(serde_json::to_vec_pretty(&value)?)
        }),
    )?;
    Ok(
        json!({"status":if complete {"collected"} else {"partial"},"artifact":directory.join("graph.json"),
        "files":graph.completed_files.len(),"symbols":value["symbols"].as_object().map_or(0, |s| s.len()),
        "calls":value["calls"].as_array().map_or(0, |c| c.len()),
        "references":value["references"].as_array().map_or(0, |r| r.len()),"issues":graph.issues,
        "analyzers":analyzers,"elapsed_seconds":started.elapsed().as_secs_f64(),
        "omitted_symbols":graph.omitted_symbols,"omitted_external_relationships":graph.omitted_external}),
    )
}

fn collect_server(
    root: &Path,
    directory: &Path,
    selected: &[PathBuf],
    config: &ServerConfig,
    sources: &BTreeMap<String, String>,
    graph: &mut Graph,
    interrupted: fn() -> bool,
) -> Result<Value> {
    let executable = executable(directory, config).context("configured language server is not installed or executable; install it separately or set command to an existing executable")?;
    let (mut client, initialized) =
        client::Client::start(&executable, directory, config, interrupted)?;
    let info = initialized["serverInfo"].clone();
    let result = (|| {
        let supports = |capability: &str| {
            let value = &initialized["capabilities"][capability];
            value == true || value.is_object()
        };
        ensure!(
            supports("documentSymbolProvider"),
            "language server does not advertise documentSymbolProvider"
        );
        let references_supported = supports("referencesProvider");
        let calls_supported = supports("callHierarchyProvider");
        for capability in ["referencesProvider", "callHierarchyProvider"] {
            if !supports(capability) {
                graph.issues.push(json!({"root":relative(root, directory)?,
                    "message":format!("language server does not advertise {capability}")}));
            }
        }
        // Hold local documents open so incoming queries can see callers outside the selected seed files.
        for path in sources
            .keys()
            .map(|p| root.join(p))
            .filter(|p| p.starts_with(directory) && config.matches(p))
        {
            client.notify("textDocument/didOpen", json!({"textDocument":{
                "uri":uri(&path)?,"languageId":config.language_id,"version":1,"text":fs::read_to_string(&path)?
            }}))?;
        }
        for file in selected {
            let file_uri = uri(file)?;
            let symbols = client
                .request(
                    "textDocument/documentSymbol",
                    json!({"textDocument":{"uri":file_uri}}),
                )
                .with_context(|| format!("documentSymbol for {}", file.display()))?;
            symbol_positions(&symbols, "", &relative(root, file)?, false, graph)?;
        }
        for file in selected {
            let file_uri = uri(file)?;
            let path = relative(root, file)?;
            let seeds: Vec<_> = graph
                .nodes
                .iter()
                .filter(|(_, node)| node.path == path)
                .map(|(id, node)| (id.clone(), node.position.clone(), node.kind))
                .collect();
            for (id, position, kind) in seeds {
                if references_supported {
                    let usages = graph.query(
                        &mut client,
                        "textDocument/references",
                        json!({
                            "textDocument":{"uri":file_uri},"position":position,
                            "context":{"includeDeclaration":false}
                        }),
                        &path,
                    )?;
                    for usage in array(&usages)? {
                        let Some(path) = local_path(
                            root,
                            sources,
                            usage["uri"].as_str().context("reference has no URI")?,
                        )?
                        else {
                            graph.omitted_external += 1;
                            continue;
                        };
                        graph.usages.push(Usage {
                            target: id.clone(),
                            path,
                            range: serde_json::from_value(usage["range"].clone())?,
                        });
                    }
                }
                if !calls_supported {
                    continue;
                }
                // Constants and class members can also hold callables; use only server-reported calls.
                let prepared = graph.query(
                    &mut client,
                    "textDocument/prepareCallHierarchy",
                    json!({
                        "textDocument":{"uri":file_uri},"position":position
                    }),
                    &path,
                )?;
                if kind.callable() && array(&prepared)?.is_empty() {
                    graph
                        .omitted_symbols
                        .push(json!({"path":relative(root, file)?,
                        "position":position,"reason":"prepareCallHierarchy returned no callable"}));
                }
                for raw in array(&prepared)? {
                    let item: Item = serde_json::from_value(raw.clone())?;
                    let Some(seed) = graph.node(root, sources, &item)? else {
                        continue;
                    };
                    for (direction, endpoint) in
                        [("incomingCalls", "from"), ("outgoingCalls", "to")]
                    {
                        let result = graph.query(
                            &mut client,
                            &format!("callHierarchy/{direction}"),
                            json!({"item":raw}),
                            &path,
                        )?;
                        for call in array(&result)? {
                            let neighbor: Item = serde_json::from_value(call[endpoint].clone())?;
                            let Some(other) = graph.node(root, sources, &neighbor)? else {
                                graph.omitted_external += 1;
                                continue;
                            };
                            let (from, to) = if endpoint == "from" {
                                (&other, &seed)
                            } else {
                                (&seed, &other)
                            };
                            for raw_range in array(&call["fromRanges"])? {
                                let range: Range = serde_json::from_value(raw_range.clone())?;
                                let site = graph.nodes[from].path.clone();
                                let key = serde_json::to_string(&(from, to, &site, &range))?;
                                graph
                                    .relationships
                                    .entry(key)
                                    .or_insert_with(|| Relationship {
                                        from: from.clone(),
                                        to: to.clone(),
                                        path: site,
                                        range,
                                    });
                            }
                        }
                    }
                }
            }
            graph.completed_files.insert(relative(root, file)?);
        }
        Ok(())
    })();
    let shutdown = client.shutdown();
    result?;
    shutdown.context("shutting down language server")?;
    Ok(info)
}

impl Graph {
    fn query(
        &mut self,
        client: &mut client::Client,
        method: &str,
        params: Value,
        path: &str,
    ) -> Result<Value> {
        match client.request(method, params) {
            Ok(result) => Ok(result),
            Err(error) if error.is::<client::ResponseError>() => {
                self.issues
                    .push(json!({"path":path,"method":method,"message":format!("{error:#}")}));
                Ok(Value::Null)
            }
            Err(error) => Err(error),
        }
    }

    fn node(
        &mut self,
        root: &Path,
        sources: &BTreeMap<String, String>,
        item: &Item,
    ) -> Result<Option<String>> {
        let Some(path) = local_path(root, sources, &item.uri)? else {
            return Ok(None);
        };
        let Some(kind) = SymbolKind::from_lsp(item.kind) else {
            return Ok(None);
        };
        let position = &item.selection_range.start;
        let id = serde_json::to_string(&(&path, position.line, position.character))?;
        self.nodes.entry(id.clone()).or_insert_with(|| Node {
            path,
            name: item.name.clone(),
            kind,
            range: item.range.clone(),
            position: position.clone(),
        });
        Ok(Some(id))
    }

    fn readable(&self) -> Value {
        let mut entries = Vec::new();
        let mut counts = BTreeMap::<String, usize>::new();
        for (id, node) in &self.nodes {
            let reference = format!("{}:{}", node.path, node.name);
            *counts.entry(reference.clone()).or_default() += 1;
            entries.push((id, node, reference));
        }
        let mut references = BTreeMap::new();
        let mut symbols = BTreeMap::new();
        for (id, node, reference) in entries {
            let reference = if counts[&reference] > 1 {
                format!(
                    "{reference}@{}:{}",
                    node.position.line + 1,
                    node.position.character + 1
                )
            } else {
                reference
            };
            let range = &node.range;
            let end_line = if range.end.character == 0 && range.end.line > range.start.line {
                range.end.line
            } else {
                range.end.line + 1
            };
            symbols.insert(
                reference.clone(),
                Symbol {
                    name: node.name.clone(),
                    kind: node.kind,
                    file: node.path.clone(),
                    line: range.start.line + 1,
                    end_line,
                },
            );
            references.insert(id, reference);
        }
        let calls: BTreeSet<_> = self
            .relationships
            .values()
            .map(|call| Call {
                caller: references[&call.from].clone(),
                callee: references[&call.to].clone(),
                file: call.path.clone(),
                line: call.range.start.line + 1,
            })
            .collect();
        let usages: BTreeSet<_> = self
            .usages
            .iter()
            .map(|usage| {
                let enclosing = self
                    .nodes
                    .iter()
                    .filter(|(_, node)| {
                        node.path == usage.path
                            && node.range.start <= usage.range.start
                            && usage.range.end <= node.range.end
                    })
                    .min_by_key(|(_, node)| {
                        (std::cmp::Reverse(&node.range.start), &node.range.end)
                    });
                Reference {
                    from: enclosing.map(|(id, _)| references[id].clone()),
                    to: references[&usage.target].clone(),
                    file: usage.path.clone(),
                    line: usage.range.start.line + 1,
                    column: usage.range.start.character + 1,
                    end_line: usage.range.end.line + 1,
                    end_column: usage.range.end.character + 1,
                }
            })
            .collect();
        json!({"symbols":symbols,"calls":calls,"references":usages})
    }
}

fn symbol_positions(
    symbols: &Value,
    parent: &str,
    file: &str,
    inside_callable: bool,
    graph: &mut Graph,
) -> Result<()> {
    for symbol in array(symbols)? {
        let name = symbol["name"]
            .as_str()
            .context("document symbol has no name")?;
        let container = symbol["containerName"].as_str().unwrap_or(parent);
        let name = if container.is_empty() {
            name.to_owned()
        } else {
            format!("{container}.{name}")
        };
        let kind = symbol["kind"]
            .as_u64()
            .and_then(|kind| u32::try_from(kind).ok())
            .and_then(SymbolKind::from_lsp);
        // Keep shared state, not every function-local variable reported by an analyzer.
        if let Some(kind) = kind.filter(|kind| {
            !inside_callable || !matches!(kind, SymbolKind::Variable | SymbolKind::Constant)
        }) {
            let position = symbol
                .get("selectionRange")
                .or_else(|| symbol.get("range"))
                .or_else(|| symbol.get("location").and_then(|v| v.get("range")))
                .context("document symbol has no source range")?["start"]
                .clone();
            let parsed: Position = serde_json::from_value(position.clone())?;
            let range = symbol
                .get("range")
                .or_else(|| symbol.get("location").and_then(|v| v.get("range")))
                .context("document symbol has no implementation range")?;
            graph.nodes.insert(
                serde_json::to_string(&(file, parsed.line, parsed.character))?,
                Node {
                    name: name.clone(),
                    kind,
                    path: file.to_owned(),
                    position: parsed,
                    range: serde_json::from_value(range.clone())?,
                },
            );
        }
        if let Some(children) = symbol.get("children") {
            let inside_callable = inside_callable
                || kind.is_some_and(|kind| {
                    matches!(
                        kind,
                        SymbolKind::Method | SymbolKind::Constructor | SymbolKind::Function
                    )
                });
            symbol_positions(children, &name, file, inside_callable, graph)?;
        }
    }
    Ok(())
}

fn local_path(
    root: &Path,
    sources: &BTreeMap<String, String>,
    uri: &str,
) -> Result<Option<String>> {
    let Ok(path) = Url::parse(uri)?.to_file_path() else {
        return Ok(None);
    };
    let Ok(path) = path.canonicalize() else {
        return Ok(None);
    };
    let Ok(path) = relative(root, &path) else {
        return Ok(None);
    };
    Ok(sources.contains_key(&path).then_some(path))
}

fn array(value: &Value) -> Result<&[Value]> {
    if value.is_null() {
        return Ok(&[]);
    }
    value
        .as_array()
        .map(Vec::as_slice)
        .context("expected an LSP array or null result")
}

fn discover(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    if root.join(".git").exists() {
        let output = ProcessCommand::new("git")
            .args([
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ])
            .current_dir(root)
            .output()
            .context("discovering repository files")?;
        ensure!(
            output.status.success(),
            "git could not discover project files"
        );
        for name in output.stdout.split(|b| *b == 0).filter(|b| !b.is_empty()) {
            let path = root.join(std::str::from_utf8(name).context("source path is not UTF-8")?);
            if !excluded(&path, root)
                && path.is_file()
                && !fs::symlink_metadata(&path)?.is_symlink()
            {
                let canonical = path.canonicalize()?;
                if canonical.starts_with(root) {
                    files.push(canonical);
                }
            }
        }
    } else {
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let path = entry.path();
                if excluded(&path, root) || entry.file_type()?.is_symlink() {
                    continue;
                }
                if entry.file_type()?.is_dir() {
                    directories.push(path);
                } else if entry.file_type()?.is_file() {
                    files.push(path);
                }
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn excluded(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|p| {
        p.components().any(|c| {
            matches!(
                c.as_os_str().to_str(),
                Some(
                    ".git"
                        | ".intent"
                        | "node_modules"
                        | ".venv"
                        | "venv"
                        | "__pycache__"
                        | "target"
                )
            )
        })
    })
}

fn server_root(root: &Path, file: &Path, config: &ServerConfig) -> PathBuf {
    file.parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .take_while(|p| p.starts_with(root))
        .find(|p| {
            config
                .root_markers
                .iter()
                .any(|marker| p.join(marker).exists())
        })
        .unwrap_or(root)
        .to_path_buf()
}

fn executable(root: &Path, config: &ServerConfig) -> Option<PathBuf> {
    let command = config.command.first()?;
    let path = Path::new(command);
    let candidates = if path.is_absolute() || path.components().count() > 1 {
        vec![root.join(path)]
    } else {
        let search = config
            .env
            .get("PATH")
            .map(std::ffi::OsString::from)
            .or_else(|| env::var_os("PATH"))?;
        env::split_paths(&search)
            .map(|p| root.join(p).join(path))
            .collect()
    };
    for candidate in candidates {
        #[cfg(windows)]
        let candidates: Vec<_> = std::iter::once(candidate.clone())
            .chain(
                env::var("PATHEXT")
                    .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
                    .split(';')
                    .map(|ext| PathBuf::from(format!("{}{}", candidate.display(), ext))),
            )
            .collect();
        #[cfg(not(windows))]
        let candidates = [candidate];
        for path in candidates {
            if !path.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if fs::metadata(&path).ok()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(path);
        }
    }
    None
}

fn relative(root: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(root)?
        .to_str()
        .context("source path is not UTF-8")?
        .replace('\\', "/"))
}

fn uri(path: &Path) -> Result<String> {
    Url::from_file_path(path)
        .map(String::from)
        .map_err(|_| anyhow::anyhow!("invalid local file URI"))
}
