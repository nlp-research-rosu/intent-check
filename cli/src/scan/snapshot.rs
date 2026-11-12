use super::{
    Depth, Host,
    redact::{self, Redactor},
    support::{clip, hash, re},
};
use anyhow::{Context, Result, bail, ensure};
use flate2::{Compression, write::GzEncoder};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const MAX_FILES: usize = 3000;
const MAX_TEXT: usize = 15728640;
const MAX_FILE: usize = 524288;
const MAX_UPLOAD: usize = 16777216;
const JSON_CAP: usize = 20971520 - 1048576;
const MAX_TRIMMED: usize = 5000;

pub(super) struct Snapshot {
    pub root: PathBuf,
    pub gz: Vec<u8>,
    pub source: Value,
    pub files: usize,
    pub bytes: usize,
    pub redactions: u64,
    pub over: usize,
}

pub(super) fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let path = path.canonicalize()?;
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(path)
}

// Read stdout concurrently so a full pipe cannot block Git or its stdin writer.
fn git_input(cwd: &Path, args: &[&str], input: Option<Vec<u8>>, timeout: u64) -> Option<String> {
    let mut command = Command::new("git");
    command
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    if let Some(input) = input
        && let Some(mut stdin) = child.stdin.take()
    {
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(256 * 1024 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send((result.is_ok(), bytes));
    });
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let (read, bytes) = rx.recv_timeout(Duration::from_secs(1)).ok()?;
    (success && read && bytes.len() <= 256 * 1024 * 1024)
        .then(|| String::from_utf8_lossy(&bytes).into_owned())
}
pub(super) fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    git_input(cwd, args, None, 3000)
}
pub(super) fn root(cwd: &Path) -> Option<PathBuf> {
    git(cwd, &["rev-parse", "--show-toplevel"]).and_then(|s| canonical(Path::new(s.trim())).ok())
}

fn remote(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().any(char::is_whitespace) {
        return None;
    }
    let (host, rest) =
        if let Some(c) = re(r"(?i)^([a-z][a-z0-9+.-]*)://([^/]*)(/.*)?$").captures(raw) {
            let proto = c[1].to_ascii_lowercase();
            if !["http", "https", "ssh", "git", "git+ssh", "ssh+git"].contains(&proto.as_str()) {
                return None;
            }
            let auth = c[2].rsplit('@').next()?;
            let host = if proto == "http" || proto == "https" {
                auth.into()
            } else {
                re(r":\d*$").replace(auth, "").into_owned()
            };
            (host, c.get(3).map(|m| m.as_str()).unwrap_or("").to_owned())
        } else {
            let c = re(r"^(?:[^@/\s]+@)?([^:/\s]+):(.+)$").captures(raw)?;
            if c[1].len() == 1 || c[2].starts_with('/') {
                return None;
            }
            (
                c[1].to_owned(),
                format!("/{}", c[2].trim_start_matches('/')),
            )
        };
    if host.is_empty() || host.contains('@') || host.chars().any(char::is_whitespace) {
        return None;
    }
    let rest = re(r"[?#].*$").replace(&rest, "");
    let rest = rest.trim_end_matches('/');
    let rest = re(r"(?i)\.git$").replace(rest, "");
    let url = format!("https://{}{rest}", host.to_ascii_lowercase());
    (url.len() <= 500).then_some(url)
}

fn path_reason(path: &str) -> Option<&'static str> {
    let base = path.rsplit('/').next().unwrap_or("");
    if redact::never(path) || re(r"(?i)^\.(envrc|npmrc|netrc|pypirc|git-credentials|pgpass|htpasswd)$|\.(tfvars|jks|keystore|p8|p12|pfx|pem|key)$|^secrets(\..*)?$|^service[-_]account.*\.json$|^id_(rsa|dsa|ecdsa|ed25519)").is_match(base) { return Some("secret"); }
    if path.split('/').rev().skip(1).any(|p| {
        [
            "node_modules",
            "vendor",
            "third_party",
            "dist",
            "build",
            "out",
            "target",
            ".venv",
            "venv",
            "bower_components",
        ]
        .contains(&p)
    }) {
        return Some("vendored");
    }
    if [
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "Cargo.lock",
        "poetry.lock",
        "Gemfile.lock",
        "composer.lock",
        "go.sum",
        "uv.lock",
        "bun.lock",
        "bun.lockb",
        "Pipfile.lock",
        "mix.lock",
        "pubspec.lock",
        "Podfile.lock",
        "flake.lock",
        "npm-shrinkwrap.json",
        "packages.lock.json",
    ]
    .contains(&base)
    {
        return Some("lockfile");
    }
    if re(r"(?i)\.min\.[^/]+$|\.map$").is_match(base) {
        return Some("generated");
    }
    None
}
fn priority(path: &str) -> (u8, usize, &str) {
    let parts: Vec<_> = path.split('/').collect();
    let base = parts.last().copied().unwrap_or("");
    let ext = base
        .rfind('.')
        .filter(|i| *i > 0)
        .map(|i| base[i..].to_ascii_lowercase())
        .unwrap_or_default();
    let test = parts[..parts.len().saturating_sub(1)]
        .iter()
        .any(|p| ["tests", "__tests__", "test", "spec", "__mocks__"].contains(p))
        || re(r"^test_|_test\.[^.]+$|\.(spec|test)\.[^.]+$").is_match(base);
    let doc = [
        ".md",
        ".mdx",
        ".rst",
        ".txt",
        ".adoc",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".cfg",
        ".conf",
        ".xml",
        ".csv",
        ".env",
        ".properties",
        ".lock",
    ]
    .contains(&ext.as_str());
    (
        if test {
            1
        } else if doc {
            2
        } else {
            0
        },
        parts.len(),
        path,
    )
}

pub(super) fn build(cwd: &Path, scope: Option<&str>, host: Host, depth: Depth) -> Result<Snapshot> {
    let root = root(cwd).context("Scan needs a git repository: run it from inside one.")?;
    let scope = if let Some(scope) = scope {
        let real = canonical(&cwd.join(scope))
            .with_context(|| format!("{scope}: not found, so nothing was scanned."))?;
        let rel = real
            .strip_prefix(&root)
            .map_err(|_| anyhow::anyhow!("{scope}: outside the repo, so nothing was scanned."))?
            .to_string_lossy()
            .replace('\\', "/");
        ensure!(
            !rel.starts_with(".."),
            "{scope}: outside the repo, so nothing was scanned."
        );
        if rel.is_empty() { None } else { Some(rel) }
    } else {
        None
    };
    let mut args = vec!["ls-files", "-co", "--exclude-standard", "-z"];
    let literal = scope.as_ref().map(|s| format!(":(literal){s}"));
    if let Some(scope) = &literal {
        args.extend(["--", scope]);
    }
    let ls = git_input(&root, &args, None, 30000)
        .context("Scan could not list the repo's files with git.")?;
    let mut trimmed = Vec::new();
    let mut trimmed_total = 0;
    let mut trim = |path: &str, reason: &str| {
        trimmed_total += 1;
        if trimmed.len() < MAX_TRIMMED {
            trimmed.push(json!({"path":path,"reason":reason}));
        }
    };
    let mut seen = BTreeSet::new();
    let mut candidates = Vec::new();
    for path in ls.split('\0').filter(|p| !p.is_empty()) {
        if !seen.insert(path)
            || path.encode_utf16().count() > 1024
            || path.starts_with('/')
            || path.ends_with('/')
            || path.contains(['\\', '\0'])
            || path.contains("//")
            || path.split('/').any(|p| p == "..")
            || re(r"^[A-Za-z]:").is_match(path)
        {
            continue;
        }
        if path.starts_with(".intent/") && path != ".intent/NOTES.md" {
            continue;
        }
        if let Some(reason) = path_reason(path) {
            trim(path, reason);
        } else {
            candidates.push(path.to_owned());
        }
    }
    let attrs = if candidates.is_empty() {
        String::new()
    } else {
        git_input(
            &root,
            &[
                "check-attr",
                "-z",
                "--stdin",
                "linguist-generated",
                "linguist-vendored",
            ],
            Some((candidates.join("\0") + "\0").into_bytes()),
            30000,
        )
        .unwrap_or_default()
    };
    let mut excluded = BTreeMap::new();
    let fields: Vec<_> = attrs.split('\0').collect();
    for chunk in fields.chunks(3) {
        if chunk.len() == 3 && ["set", "true"].contains(&chunk[2]) {
            excluded.insert(
                chunk[0],
                if chunk[1] == "linguist-vendored" {
                    "vendored"
                } else {
                    "generated"
                },
            );
        }
    }
    candidates.retain(|p| {
        if let Some(reason) = excluded.get(p.as_str()) {
            trim(p, reason);
            false
        } else {
            true
        }
    });
    candidates.sort_by(|a, b| priority(a).cmp(&priority(b)));
    let redactor = Redactor::new();
    let mut files = Vec::new();
    let mut sources = Vec::new();
    let (mut bytes, mut json_bytes, mut redactions, mut over) = (0, 0, 0, 0);
    for path in candidates {
        if files.len() >= MAX_FILES || bytes >= MAX_TEXT - 64 {
            trim(&path, "over_cap");
            over += 1;
            continue;
        }
        let abs = root.join(&path);
        let Ok(st) = fs::symlink_metadata(&abs) else {
            continue;
        };
        if !st.is_file() {
            if st.is_symlink() {
                trim(&path, "symlink");
            }
            continue;
        }
        if !canonical(&abs).is_ok_and(|p| p.starts_with(&root)) {
            trim(&path, "symlink");
            continue;
        }
        if st.len() > MAX_FILE as u64 {
            trim(&path, "too_large");
            continue;
        }
        let Ok(raw) = fs::read(abs) else {
            continue;
        };
        let Ok(text) = std::str::from_utf8(&raw) else {
            trim(&path, "binary");
            continue;
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        if text.contains('\0') {
            trim(&path, "binary");
            continue;
        }
        if text.trim().is_empty() {
            continue;
        }
        let (redacted, n) = redactor.text(text);
        if redacted.contains('\0') {
            trim(&path, "binary");
            continue;
        }
        if redacted.split('\n').count() != text.split('\n').count() {
            trim(&path, "redaction_error");
            continue;
        }
        let file = json!({"path":path,"content":redacted});
        let cost = serde_json::to_vec(&file)?.len() + 2;
        if redacted.len() > MAX_FILE
            || bytes + redacted.len() > MAX_TEXT
            || json_bytes + cost > JSON_CAP
        {
            trim(&path, "over_cap");
            over += 1;
            continue;
        }
        sources.push(
            json!({"path":path,"source_sha256":hash(&raw),"submitted_sha256":hash(&redacted)}),
        );
        bytes += redacted.len();
        json_bytes += cost;
        redactions += n;
        files.push(file);
    }
    ensure!(!files.is_empty(), "Scan found no text files to scan here.");
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let head = git(&root, &["rev-parse", "--verify", "-q", "HEAD"])
        .map(|s| s.trim().to_owned())
        .filter(|s| re(r"^[0-9a-f]{40}([0-9a-f]{24})?$").is_match(s));
    let branch = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .filter(|s| !s.trim().is_empty())
        .map(|s| clip(s.trim(), 255));
    let meta = json!({"contract_version":"1","host":host.as_str(),"plugin_version":clip(env!("CARGO_PKG_VERSION"),40),"os":if cfg!(windows){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"},"remote_url":git(&root,&["remote","get-url","origin"]).and_then(|s|remote(&s)),"head_sha":head,"branch":branch,"dirty":git_input(&root,&["status","--porcelain=v1"],None,15000).is_some_and(|s|!s.trim().is_empty()),"scope":scope,"file_count":files.len(),"bytes":bytes,"trimmed":trimmed});
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&serde_json::to_vec(
        &json!({"meta":meta,"files":files,"depth":depth.as_str()}),
    )?)?;
    let gz = encoder.finish()?;
    if gz.len() > MAX_UPLOAD {
        bail!(
            "The snapshot is too large to upload even compressed. Narrow it to one folder: /intent:scan <folder>."
        );
    }
    let mut source = meta;
    source["files"] = json!(sources);
    source["snapshot_sha256"] = json!(hash(&gz));
    source["trimmed_total"] = json!(trimmed_total);
    Ok(Snapshot {
        root,
        gz,
        source,
        files: files.len(),
        bytes,
        redactions,
        over,
    })
}
