use crate::{CommandResult, session};
use anyhow::{Context, Result, ensure};
use clap::Args;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Args, Debug)]
pub struct ViewArgs {
    /// Export one offline HTML snapshot instead of starting a live viewer.
    #[arg(long, conflicts_with = "port")]
    output: Option<PathBuf>,
    /// Loopback port; by default the OS selects a free port.
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// Plugin data directory for active file checks; repeat for multiple hosts.
    /// Defaults to installed Claude Code and Codex plugin data directories.
    #[arg(long)]
    plugin_data: Vec<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    name: String,
    generated: u64,
    files: BTreeMap<String, String>,
    active: Vec<ActiveCheck>,
    scan_states: BTreeMap<String, Value>,
    freshness: BTreeMap<String, String>,
    assurance: BTreeMap<String, String>,
    requirement_freshness: BTreeMap<String, String>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveCheck {
    id: String,
    kind: &'static str,
    status: &'static str,
    paths: Vec<String>,
    url: Option<String>,
    submitted_at: Value,
}

fn project_name(root: &Path) -> String {
    let remote = Command::new("git")
        .args(["config", "--get", "remote.origin.url"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    remote
        .as_deref()
        .and_then(|url| {
            url.trim()
                .trim_end_matches('/')
                .rsplit(['/', ':', '\\'])
                .next()
        })
        .map(|name| name.strip_suffix(".git").unwrap_or(name))
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            root.file_name()
                .unwrap_or(root.as_os_str())
                .to_string_lossy()
                .into_owned()
        })
}

fn plugin_directories(explicit: Vec<PathBuf>) -> Vec<PathBuf> {
    if !explicit.is_empty() {
        return explicit;
    }
    let mut dirs = Vec::new();
    for key in ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"] {
        if let Some(dir) = env::var_os(key) {
            dirs.push(PathBuf::from(dir));
        }
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    for (key, default) in [("CLAUDE_CONFIG_DIR", ".claude"), ("CODEX_HOME", ".codex")] {
        if let Some(base) = env::var_os(key)
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(default)))
        {
            dirs.push(base.join("plugins/data/intent-intentcomputing"));
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

fn entries(dir: &Path) -> Result<Vec<fs::DirEntry>> {
    match fs::read_dir(dir) {
        Ok(entries) => Ok(entries.collect::<std::io::Result<Vec<_>>>()?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn read_json(file: &Path) -> Option<Value> {
    let metadata = fs::symlink_metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(file).ok()?).ok()
}

fn collect_files(root: &Path, dir: &Path, snapshot: &mut Snapshot) -> Result<()> {
    for entry in entries(dir)? {
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let rel = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            snapshot.warnings.push(format!("Skipped symlink: {rel}"));
        } else if kind.is_dir() {
            // Never embed private input copies or the session authoring workspace.
            if name == "inputs"
                && rel.split('/').count() == 3
                && (rel.starts_with("proofs/") || rel.starts_with("runs/"))
                || rel == "prove/sessions"
            {
                continue;
            }
            collect_files(root, &path, snapshot)?;
        } else if kind.is_file() {
            let review_artifact = rel.starts_with("files/")
                && rel.rsplit('/').nth(2) == Some("checks")
                && matches!(
                    name.to_str(),
                    Some(
                        "meta.json"
                            | "INTENT.md"
                            | "SPEC.k"
                            | "VERIFICATION.k"
                            | "SEMANTICS.k"
                            | "REASONING.md"
                            | "VERDICT.md"
                    )
                );
            let requirement = rel.starts_with("files/") && rel.ends_with("/requirements.json");
            let run = rel.split('/').count() == 3
                && rel.starts_with("runs/")
                && matches!(
                    name.to_str(),
                    Some("request.json" | "result.json" | "report.json")
                );
            let proof = rel.split('/').count() == 3
                && rel.starts_with("proofs/")
                && matches!(name.to_str(), Some("SCOPE.md" | "PROOF.md" | "prove.sh"));
            if !(review_artifact
                || requirement
                || run
                || proof
                || matches!(rel.as_str(), "README.md" | "REQUIREMENTS.md"))
            {
                continue;
            }
            // Only evidence/document formats are exported, not temporary or binary files.
            if !matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("md" | "k" | "mpy" | "sh" | "json")
            ) {
                continue;
            }
            if entry.metadata()?.len() > MAX_FILE_BYTES {
                snapshot
                    .warnings
                    .push(format!("Skipped file over 16 MiB: {rel}"));
                continue;
            }
            match fs::read_to_string(&path) {
                Ok(text) => {
                    if name == "requirements.json" {
                        let local = rel
                            .strip_prefix("files/")
                            .and_then(|p| p.strip_suffix("/requirements.json"));
                        if crate::requirements::read_document(&path, local).is_err() {
                            snapshot
                                .warnings
                                .push(format!("Skipped invalid requirements: {rel}"));
                            continue;
                        }
                    }
                    snapshot.files.insert(rel, text);
                }
                Err(error) => snapshot
                    .warnings
                    .push(format!("Could not read {rel}: {}", error.kind())),
            }
        }
    }
    Ok(())
}

fn matches_project(job: &Value, root: &Path) -> bool {
    job["repo"]
        .as_str()
        .and_then(|repo| Path::new(repo).canonicalize().ok())
        .as_deref()
        == Some(root)
}

fn snapshot(root: &Path, name: &str, data_dirs: &[PathBuf]) -> Result<Snapshot> {
    let mut snapshot = Snapshot {
        name: name.into(),
        generated: SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis()
            .try_into()?,
        files: BTreeMap::new(),
        active: Vec::new(),
        scan_states: BTreeMap::new(),
        freshness: BTreeMap::new(),
        assurance: BTreeMap::new(),
        requirement_freshness: BTreeMap::new(),
        warnings: Vec::new(),
    };
    let intent = root.join(".intent");
    if fs::symlink_metadata(&intent).is_ok_and(|m| m.is_symlink()) {
        anyhow::bail!(".intent must not be a symlink");
    }
    collect_files(&intent, &intent, &mut snapshot)?;
    // Validate all structured scopes, including files that were not eligible for export.
    let current_requirements = crate::requirements::documents(root);
    if current_requirements.is_err() {
        snapshot.warnings.push("Local requirements are invalid; requirement freshness is unknown. Run intent-check requirements context to inspect the error.".into());
    }
    let current_hashes = current_requirements
        .as_ref()
        .ok()
        .map(|docs| {
            docs.iter()
                .flat_map(|(_, _, doc)| &doc.requirements)
                .map(|r| Ok((r.id.clone(), crate::requirements::record_hash(r)?)))
                .collect::<Result<BTreeMap<_, _>>>()
        })
        .transpose()?;
    for (path, text) in &snapshot.files {
        if path.starts_with("files/") && path.ends_with("/meta.json") {
            let meta: Value = serde_json::from_str(text)?;
            snapshot
                .freshness
                .insert(path.clone(), source_freshness(root, &meta));
        }
        if path.starts_with("runs/") && path.ends_with("/request.json") {
            let request: Value = serde_json::from_str(text)?;
            let mut observations = Vec::new();
            for source in request["targets"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(request["sources"].as_array().into_iter().flatten())
                .chain(request["source"]["files"].as_array().into_iter().flatten())
            {
                if source["role"] == "requirements" {
                    continue;
                }
                observations.push(source_freshness(root, source));
            }
            let mut inputs_match = true;
            for input in request["inputs"].as_array().into_iter().flatten() {
                let Some(relative) = input["path"].as_str() else {
                    inputs_match = false;
                    continue;
                };
                let file = intent.join(relative);
                if crate::storage::safe_parent(root, &file).is_err()
                    || fs::read(file).ok().map(crate::storage::hash).as_deref()
                        != input["sha256"].as_str()
                {
                    inputs_match = false;
                }
            }
            let fresh = if !inputs_match {
                "stale"
            } else if observations.is_empty() {
                "unknown"
            } else if observations.iter().all(|s| s == "current") {
                "current"
            } else if observations.iter().any(|s| s == "stale") {
                "stale"
            } else {
                "missing_or_unknown"
            };
            snapshot.freshness.insert(path.clone(), fresh.into());
            snapshot.requirement_freshness.insert(
                path.clone(),
                requirement_freshness(
                    root,
                    &request["requirement_binding"],
                    current_hashes.as_ref(),
                ),
            );
            let result = snapshot
                .files
                .get(&path.replace("request.json", "result.json"))
                .and_then(|t| serde_json::from_str::<Value>(t).ok());
            let level = if let Some(result) = result {
                if request["operation"] == "prove" {
                    // Task.result is aggregate and can include admitted/trusted claims or a
                    // cached result. Neither tool exits nor arbitrary logs certify coverage.
                    "server_reported_only; per-claim coverage unestablished; audit not recorded"
                } else if matches!(request["operation"].as_str(), Some("check" | "deepscan"))
                    && result["status"] == "done"
                    && (request["operation"] != "check" || result["bindings_valid"] == true)
                {
                    "llm_reviewed"
                } else {
                    "unchecked"
                }
            } else {
                "unchecked"
            };
            snapshot.assurance.insert(path.clone(), level.into());
        }
    }
    for entry in entries(&intent.join(".queue"))? {
        if let Some(item) = read_json(&entry.path()) {
            snapshot.active.push(ActiveCheck {
                id: entry.file_name().to_string_lossy().into_owned(),
                kind: "File review",
                status: "queued",
                paths: item["paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                url: None,
                submitted_at: item["at"].clone(),
            });
        }
    }
    let mut seen = BTreeSet::new();
    if !data_dirs.iter().any(|dir| dir.join("sessions").is_dir()) {
        snapshot.warnings.push("Active plugin checks are unavailable: no plugin session state found. Use --plugin-data for a custom installation.".into());
    }
    for dir in data_dirs {
        for entry in entries(&dir.join("deepscans"))? {
            let Some(scan) = read_json(&entry.path()) else {
                continue;
            };
            let matches = scan["repo_root"]
                .as_str()
                .and_then(|repo| Path::new(repo).canonicalize().ok())
                .as_deref()
                == Some(root);
            if matches && let Some(id) = scan["job_id"].as_str() {
                snapshot.scan_states.insert(
                    id.into(),
                    json!({"status": scan["status"], "stage": scan["stage"]}),
                );
            }
        }
        for entry in entries(&dir.join("sessions"))? {
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Some(state) = read_json(&entry.path()) else {
                continue;
            };
            let jobs = state["pending"].as_array().into_iter().flatten().chain(
                state["edit_jobs"]
                    .as_object()
                    .into_iter()
                    .flat_map(|jobs| jobs.values()),
            );
            for job in jobs {
                if !matches_project(job, root) || job["settled"] == true {
                    continue;
                }
                let Some(id) = job["job_id"].as_str() else {
                    continue;
                };
                if !seen.insert(id.to_owned()) {
                    continue;
                }
                // Select task metadata only. Session prompts, patches and transcripts never leave this process.
                snapshot.active.push(ActiveCheck {
                    id: id.into(),
                    kind: if job["edit"] == true {
                        "Live check"
                    } else {
                        "File review"
                    },
                    status: "submitted",
                    paths: job["sent"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|sent| sent["rel"].as_str())
                        .map(str::to_owned)
                        .collect(),
                    url: job["url"].as_str().map(str::to_owned),
                    submitted_at: job["submitted_at"].clone(),
                });
            }
        }
    }
    snapshot.active.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(snapshot)
}

fn requirement_freshness(
    root: &Path,
    binding: &Value,
    current: Option<&BTreeMap<String, String>>,
) -> String {
    let Some(records) = binding["records"].as_array() else {
        return "unknown".into();
    };
    if binding["version"] != 1 {
        return "unknown".into();
    }
    if records.is_empty() && binding["brief"].is_null() {
        return "not_applicable".into();
    }
    let Some(current) = current else {
        return "unknown".into();
    };
    for record in records {
        let (Some(id), Some(hash)) = (record["id"].as_str(), record["record_sha256"].as_str())
        else {
            return "unknown".into();
        };
        if current.get(id).map(String::as_str) != Some(hash) {
            return "stale".into();
        }
    }
    if !binding["brief"].is_null() {
        let Some(hash) = binding["brief"]["source_sha256"].as_str() else {
            return "unknown".into();
        };
        match crate::requirements::brief(root) {
            Ok(Some(text)) if crate::storage::hash(&text) == hash => (),
            Ok(_) => return "stale".into(),
            Err(_) => return "unknown".into(),
        }
    }
    "current".into()
}

fn source_freshness(root: &Path, source: &Value) -> String {
    let Some(path) = source["path"].as_str() else {
        return "unknown".into();
    };
    if crate::requirements::relative_path(path).is_err() {
        return "unknown".into();
    }
    let file = root.join(path);
    let Ok(real) = file.canonicalize() else {
        return "missing".into();
    };
    if !real.starts_with(root) {
        return "unknown".into();
    }
    match fs::read(real) {
        Ok(bytes) => {
            if source["source_sha256"].as_str() == Some(crate::storage::hash(bytes).as_str()) {
                "current"
            } else {
                "stale"
            }
        }
        Err(_) => "unknown",
    }
    .into()
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            out.push(if index > chunk.len() {
                '='
            } else {
                ALPHABET[((bits >> (18 - index * 6)) & 63) as usize] as char
            });
        }
    }
    out
}

fn html(snapshot: &Snapshot, data_url: Option<&str>) -> Result<String> {
    let payload = serde_json::to_string(&json!({"snapshot": snapshot, "dataUrl": data_url}))?
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(include_str!("viewer/index.html")
        .replace("__STYLE__", include_str!("viewer/style.css"))
        .replace(
            "__FONT__",
            &base64(include_bytes!("viewer/geist-latin.woff2")),
        )
        .replace("__SCRIPT__", include_str!("viewer/app.js"))
        .replace("__LOGO__", include_str!("viewer/mark.svg"))
        .replace("__FONT_LICENSE__", include_str!("viewer/Geist-OFL.txt"))
        .replace(
            "__CONNECT__",
            if data_url.is_some() {
                "'self'"
            } else {
                "'none'"
            },
        )
        .replace("__DATA__", &payload))
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) -> Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    Ok(())
}

fn request(
    stream: &mut TcpStream,
    address: &str,
    route: &str,
    root: &Path,
    name: &str,
    dirs: &[PathBuf],
) -> Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    while bytes.len() < 8192 && !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let headers = String::from_utf8_lossy(&bytes);
    let mut lines = headers.lines();
    let request = lines
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    let host = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim());
    if host != Some(address) || request.len() != 3 || request[0] != "GET" {
        return respond(stream, "403 Forbidden", "text/plain", b"Forbidden");
    }
    if request[1] != route && request[1] != format!("{route}data") {
        return respond(stream, "404 Not Found", "text/plain", b"Not found");
    }
    match snapshot(root, name, dirs) {
        Ok(snapshot) if request[1] == route => respond(
            stream,
            "200 OK",
            "text/html; charset=utf-8",
            html(&snapshot, Some(&format!("{route}data")))?.as_bytes(),
        ),
        Ok(snapshot) => respond(
            stream,
            "200 OK",
            "application/json",
            &serde_json::to_vec(&snapshot)?,
        ),
        Err(error) => respond(
            stream,
            "500 Internal Server Error",
            "application/json",
            &serde_json::to_vec(&json!({"error": error.to_string()}))?,
        ),
    }
}

pub fn view(args: ViewArgs) -> CommandResult {
    let root = session::project_root(&env::current_dir()?)?;
    let name = project_name(&root);
    let dirs = plugin_directories(args.plugin_data);
    let initial = snapshot(&root, &name, &dirs)?;
    if let Some(output) = args.output {
        ensure!(
            !output.exists(),
            "Output already exists; choose a new --output path"
        );
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .with_context(|| format!("Could not create {}", output.display()))?;
        file.write_all(html(&initial, None)?.as_bytes())?;
        return Ok((
            0,
            json!({"status": "exported", "name": name, "file": output, "artifacts": initial.files.len()}),
        ));
    }
    let listener =
        TcpListener::bind(("127.0.0.1", args.port)).context("Could not bind local viewer")?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?.to_string();
    let route = format!("/{}/", Uuid::new_v4());
    let stopped = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&stopped);
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))?;
    println!(
        "{}",
        json!({"status": "listening", "name": name, "url": format!("http://{address}{route}")})
    );
    std::io::stdout().flush()?;
    while !stopped.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Err(error) = request(&mut stream, &address, &route, &root, &name, &dirs) {
                    eprintln!("Viewer request: {error}");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50))
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok((0, json!({"status": "stopped"})))
}
