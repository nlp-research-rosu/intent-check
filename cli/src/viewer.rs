use crate::{CommandResult, channel, session};
use anyhow::{Context, Result, ensure};
use clap::Args;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
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
    /// Plugin data directory for explicit Scans; repeat for multiple hosts.
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
    scan_states: BTreeMap<String, Value>,
    warnings: Vec<String>,
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
            let selected = channel::settings();
            dirs.push(
                base.join("plugins/data")
                    .join(format!("{}-{}", selected.plugin, selected.marketplace)),
            );
        }
    }
    if let Some(home) = &home {
        dirs.push(home.join(".gemini/config/plugin-data/intent"));
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
            collect_files(root, &path, snapshot)?;
        } else if kind.is_file() {
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

fn snapshot(root: &Path, name: &str, data_dirs: &[PathBuf]) -> Result<Snapshot> {
    let mut snapshot = Snapshot {
        name: name.into(),
        generated: SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis()
            .try_into()?,
        files: BTreeMap::new(),
        scan_states: BTreeMap::new(),
        warnings: Vec::new(),
    };
    let intent = root.join(".intent");
    if fs::symlink_metadata(&intent).is_ok_and(|m| m.is_symlink()) {
        anyhow::bail!(".intent must not be a symlink");
    }
    collect_files(&intent, &intent, &mut snapshot)?;
    for dir in data_dirs {
        for entry in entries(&dir.join("scans"))? {
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
    }
    Ok(snapshot)
}

fn html(snapshot: &Snapshot, data_url: Option<&str>) -> Result<String> {
    let payload = serde_json::to_string(&json!({"snapshot": snapshot, "dataUrl": data_url}))?
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(include_str!("viewer/index.html")
        .replace("__STYLE__", include_str!("viewer/style.css"))
        .replace("__SCRIPT__", include_str!("viewer/app.js"))
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
