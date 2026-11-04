//! Native plugin execution. Host protocols never use the public CLI JSON envelope.
mod capture;
mod controls;
mod filter;
mod payload;
mod protocol;
mod redact;
mod render;
mod runner;
mod scan;
mod state;

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) struct Fixture {
        pub root: PathBuf,
        pub rt: Runtime,
        directory: PathBuf,
    }

    impl Fixture {
        pub fn new() -> Self {
            let directory = env::temp_dir().join(format!("intent-native-{}", id()));
            let root = directory.join("repo");
            fs::create_dir_all(&root).expect("create test project");
            let root = capture::canonical(&root).expect("canonical test project");
            Self {
                root,
                rt: Runtime {
                    host: "claude-code".into(),
                    root: None,
                    data: directory.join("data"),
                    version: env!("CARGO_PKG_VERSION").into(),
                    config: crate::config::Config::default(),
                    started: Instant::now(),
                },
                directory,
            }
        }

        pub fn write(&self, rel: &str, text: &str) -> PathBuf {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().expect("fixture parent"))
                .expect("create fixture parent");
            fs::write(&path, text).expect("write fixture");
            path
        }

        pub fn git(&self, args: &[&str]) -> String {
            let mut command = vec!["-c", "user.name=test", "-c", "user.email=test@example.test"];
            command.extend_from_slice(args);
            capture::git(&self.root, &command)
                .unwrap_or_else(|| panic!("fixture git failed: {args:?}"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn clip(text: &str, limit: usize) -> String {
    // Host and service limits are expressed in JavaScript UTF-16 code units.
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= limit
        })
        .collect()
}

pub(crate) fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub(crate) fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(crate) fn number(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}
pub(crate) fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
pub(crate) fn re(pattern: &str) -> regex::Regex {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };
    static PATTERNS: OnceLock<Mutex<HashMap<String, regex::Regex>>> = OnceLock::new();
    PATTERNS
        .get_or_init(Mutex::default)
        .lock()
        .expect("Regex cache lock poisoned")
        .entry(pattern.into())
        .or_insert_with(|| regex::Regex::new(pattern).expect("Invalid built-in runtime pattern"))
        .clone()
}
pub(crate) fn hash(text: impl AsRef<[u8]>) -> String {
    crate::storage::hash(text)
}

// RFC3339 milliseconds without a timezone/process dependency.
pub(crate) fn iso(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms / 3600000 % 24,
        ms / 60000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

pub(crate) fn parse_time(value: &Value) -> u64 {
    if let Some(n) = value.as_u64() {
        return n;
    }
    let s = string(value);
    let parts: Vec<i64> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() < 6 {
        return 0;
    }
    let (mut y, m, d) = (parts[0], parts[1], parts[2]);
    y -= i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + d - 1 - 719468;
    (days * 86400000
        + parts[3] * 3600000
        + parts[4] * 60000
        + parts[5] * 1000
        + parts.get(6).copied().unwrap_or(0))
    .max(0) as u64
}

#[derive(Clone)]
pub(crate) struct Runtime {
    pub host: String,
    pub root: Option<PathBuf>,
    pub data: PathBuf,
    pub version: String,
    pub config: crate::config::Config,
    pub started: Instant,
}

#[derive(clap::Args)]
pub(crate) struct PublicArgs {
    #[arg(long, hide = true, default_value = "claude-code", value_parser = ["claude-code", "codex"])]
    host: String,
    #[arg(long, hide = true)]
    plugin_root: Option<PathBuf>,
    #[arg(long, hide = true)]
    data: Option<PathBuf>,
}

#[derive(clap::Args)]
pub(crate) struct ReviewArgs {
    #[command(flatten)]
    runtime: PublicArgs,
    /// Paths to review; DeepScan also accepts one folder and a fast|balanced|full depth.
    targets: Vec<String>,
}

pub(crate) fn public(
    action: &str,
    args: &PublicArgs,
    project: Option<&Path>,
    targets: &[String],
) -> Result<String> {
    if let Some(project) = project {
        env::set_current_dir(crate::session::project_root(project)?)?;
    }
    let runtime = Runtime::new(
        args.host.clone(),
        args.plugin_root.clone(),
        args.data.clone(),
        action == "off",
    )?;
    match action {
        "review" => scan::queue_command(&runtime, targets),
        "deepscan" => scan::command(&runtime, targets),
        _ => controls::command(&runtime, action),
    }
}

pub(crate) fn review(action: &str, args: &ReviewArgs, project: Option<&Path>) -> Result<String> {
    public(action, &args.runtime, project, &args.targets)
}

pub(crate) fn capabilities() -> Value {
    json!({"version":env!("CARGO_PKG_VERSION"),"capabilities":["hooks-v1","requirements-context-v1","reviews-v1","deepscan-v1"]})
}

impl Runtime {
    fn new(host: String, root: Option<PathBuf>, data: Option<PathBuf>, off: bool) -> Result<Self> {
        let root = root.or_else(|| {
            env::var_os(if host == "codex" {
                "PLUGIN_ROOT"
            } else {
                "CLAUDE_PLUGIN_ROOT"
            })
            .map(PathBuf::from)
        });
        let root = root.map(|p| capture::canonical(&p).unwrap_or(p));
        let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .context("Home directory is unavailable")?;
        let data = data
            .or_else(|| {
                env::var_os("CLAUDE_PLUGIN_DATA")
                    .or_else(|| env::var_os("PLUGIN_DATA"))
                    .map(PathBuf::from)
            })
            .or_else(|| root.as_deref().and_then(state::data_from_root))
            .unwrap_or_else(|| {
                home.join(if host == "codex" { ".codex" } else { ".claude" })
                    .join("plugins/data/intent-intentcomputing")
            });
        let version = root
            .as_ref()
            .map(|root| state::read(&root.join(".claude-plugin/plugin.json")))
            .and_then(|v| v["version"].as_str().map(str::to_owned))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
        let config = if off {
            crate::config::Config::default()
        } else {
            crate::config::load()?
        };
        Ok(Self {
            host,
            root,
            data,
            version,
            config,
            started: Instant::now(),
        })
    }

    pub fn key(&self) -> Result<Option<String>> {
        crate::auth::api_key(&self.config.server_url)
    }
    pub fn settings(&self) -> Value {
        state::read(&self.data.join("config.json"))
    }
    pub fn disabled(&self) -> Option<&'static str> {
        if env::var("INTENT_DISABLED").as_deref() == Ok("1") {
            Some("INTENT_DISABLED")
        } else if env::var("DO_NOT_TRACK").as_deref() == Ok("1") {
            Some("DO_NOT_TRACK")
        } else if self.settings()["disabled"] == true {
            Some("off")
        } else {
            None
        }
    }
    pub fn live(&self) -> bool {
        match env::var("INTENT_LIVE").as_deref() {
            Ok("1") => true,
            Ok("0") => false,
            _ => self.settings()["live"] == true,
        }
    }
    pub fn global(&self) -> Value {
        state::read(&self.data.join("global.json"))
    }
    pub fn global_mut<T>(&self, f: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
        state::update(&self.data.join("global.json"), json!({}), f)
    }
    pub fn session(&self, key: &str) -> Value {
        state::session(&self.data, key)
    }
    pub fn session_mut<T>(&self, key: &str, f: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
        state::update(
            &self.data.join("sessions").join(format!("{key}.json")),
            state::empty(),
            f,
        )
    }
    pub fn paused(&self, key: &str) -> Option<Value> {
        let p = self.global()["paused"].clone();
        let identity = &hash(format!("{key}\n{}", self.version))[..16];
        (p["id"] == identity
            && !(p["source"] == "env" && now().saturating_sub(parse_time(&p["at"])) > 86400000))
            .then_some(p)
    }
    pub fn spawn(&self, action: &str, argument: &str) -> Result<()> {
        let mut cmd = Command::new(env::current_exe()?);
        cmd.args(["__worker", "--host", &self.host, "--data"])
            .arg(&self.data);
        if let Some(root) = &self.root {
            cmd.arg("--plugin-root").arg(root);
        }
        cmd.args([action, argument])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x00000008 | 0x00000200 | 0x08000000);
        }
        cmd.spawn()?;
        Ok(())
    }
    pub fn handoff(&self, action: &str, payload: &Value) -> Result<()> {
        let file = self
            .data
            .join("tmp")
            .join(format!("{action}-{}.json", id()));
        state::write(&file, payload, true)?;
        if let Err(e) = self.spawn(action, &file.to_string_lossy()) {
            let _ = fs::remove_file(file);
            return Err(e);
        }
        Ok(())
    }
    pub fn log(&self, event: &str, fields: Value) {
        let _ = (|| -> Result<()> {
            state::private_dir(&self.data)?;
            let file = self.data.join("intent.log");
            if fs::metadata(&file).is_ok_and(|m| m.len() > 1024 * 1024) {
                fs::rename(&file, file.with_extension("log.1"))?;
            }
            let mut out = state::append(&file, true)?;
            let mut value = fields;
            value["t"] = json!(iso(now()));
            value["pid"] = json!(std::process::id());
            value["event"] = json!(event);
            writeln!(out, "{value}")?;
            Ok(())
        })();
    }
}

#[derive(Default)]
pub(crate) struct Output {
    pub user: String,
    pub context: String,
    pub exit: i32,
    pub summary: String,
    pub acknowledgments: Vec<(PathBuf, String)>,
}
impl Output {
    pub fn add(&mut self, user: &str, context: &str) {
        if !user.is_empty() {
            if !self.user.is_empty() {
                self.user.push('\n');
            }
            self.user.push_str(user);
        }
        if !context.is_empty() {
            if !self.context.is_empty() {
                self.context.push_str("\n\n");
            }
            self.context.push_str(context);
        }
    }
    fn emit(self, rt: &Runtime, event: &str) -> Result<i32> {
        let (stdout, stderr) = if self.exit == 2 {
            (
                if rt.host == "codex" {
                    String::new()
                } else {
                    format!("{}\n", json!({"rewakeSummary":self.summary}))
                },
                format!("{}\n", clip(&self.context, 9500)),
            )
        } else if rt.host == "codex" {
            let mut parts = vec![];
            if !self.user.is_empty() {
                parts.push(self.user.clone());
            }
            for part in self.context.split("\n\n") {
                if !part.is_empty() && !self.user.lines().any(|line| line == part) {
                    parts.push(part.into());
                }
            }
            let text = parts.join("\n\n");
            (
                if text.trim().is_empty() {
                    String::new()
                } else {
                    format!(
                        "{}\n",
                        json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":clip(text.trim(),9000)}})
                    )
                },
                String::new(),
            )
        } else {
            let mut value = json!({});
            if !self.user.is_empty() {
                value["systemMessage"] = json!(clip(&self.user, 9000));
            }
            if !self.context.is_empty() {
                value["hookSpecificOutput"] =
                    json!({"hookEventName":event,"additionalContext":clip(&self.context,9500)});
            }
            (
                if value == json!({}) {
                    String::new()
                } else {
                    format!("{value}\n")
                },
                String::new(),
            )
        };
        io::stdout().write_all(stdout.as_bytes())?;
        io::stdout().flush()?;
        io::stderr().write_all(stderr.as_bytes())?;
        io::stderr().flush()?;
        rt.log("hook.output",json!({"hook":event,"exit":self.exit,"stdout_bytes":stdout.len(),"stderr_bytes":stderr.len()}));
        for (file, token) in self.acknowledgments {
            state::ack(&file, &token)?;
        }
        Ok(self.exit)
    }
}

fn stdin_payload() -> Value {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = io::stdin()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes);
        let value = if result.is_ok() && bytes.len() <= 16 * 1024 * 1024 {
            serde_json::from_slice(&bytes).unwrap_or(json!({}))
        } else {
            json!({})
        };
        let _ = tx.send(value);
    });
    rx.recv_timeout(Duration::from_secs(3)).unwrap_or(json!({}))
}

pub(crate) fn entry() -> Option<i32> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if !args
        .first()
        .is_some_and(|s| matches!(s.as_str(), "__hook" | "__worker"))
    {
        return None;
    }
    let kind = args.remove(0);
    let result = (|| -> Result<i32> {
        let mut host = "claude-code".to_owned();
        let mut root = None;
        let mut data = None;
        let mut i = 0;
        while i < args.len() {
            if matches!(args[i].as_str(), "--host" | "--plugin-root" | "--data") {
                if i + 1 >= args.len() {
                    bail!("Missing value for {}", args[i]);
                }
                let flag = args.remove(i);
                let value = args.remove(i);
                match flag.as_str() {
                    "--host" => host = value,
                    "--plugin-root" => root = Some(PathBuf::from(value)),
                    _ => data = Some(PathBuf::from(value)),
                }
            } else {
                i += 1;
            }
        }
        if host != "claude-code" && host != "codex" {
            bail!("Unsupported host");
        }
        let rt = Runtime::new(host, root, data, false)?;
        if kind == "__hook" {
            let action = args.first().context("Missing hook event")?;
            let event = match action.as_str() {
                "session-start" => "SessionStart",
                "prompt" => "UserPromptSubmit",
                "post-tool" => "PostToolUse",
                "stop" => "Stop",
                _ => bail!("Unknown hook event"),
            };
            let timeout = if action == "stop" {
                if rt.host == "codex" { 25000 } else { 890000 }
            } else {
                8000
            };
            let payload = stdin_payload();
            let (done, rx) = mpsc::channel::<()>();
            let watchdog = rt.clone();
            let watch_key = state::key(&payload);
            let remaining = Duration::from_millis(timeout).saturating_sub(rt.started.elapsed());
            thread::spawn(move || {
                if rx.recv_timeout(remaining).is_err() {
                    if !array(&watchdog.session(&watch_key)["pending"]).is_empty() {
                        let _ = watchdog.spawn("finish", &watch_key);
                    }
                    std::process::exit(0);
                }
            });
            let output = runner::hook(&rt, action, &payload)?;
            let exit = output.emit(&rt, event)?;
            let _ = done.send(());
            Ok(exit)
        } else if kind == "__worker" {
            let action = args.first().context("Missing worker kind")?;
            let argument = args.get(1).context("Missing worker argument")?;
            runner::worker(&rt, action, argument)?;
            Ok(0)
        } else {
            unreachable!("Only private runtime entrypoints reach this dispatcher")
        }
    })();
    Some(match result {
        Ok(exit) => exit,
        Err(error) => {
            if kind == "__hook" {
                eprintln!(
                    "Intent Check: review did not start: {error}. Run intent-check doctor to inspect setup."
                );
                0
            } else if kind == "__worker" {
                0
            } else {
                eprintln!("Intent Check: {error}");
                1
            }
        }
    })
}

pub(crate) fn cwd(payload: &Value) -> Result<PathBuf> {
    Ok(if !string(&payload["cwd"]).is_empty() {
        PathBuf::from(string(&payload["cwd"]))
    } else if let Some(p) = env::var_os("CLAUDE_PROJECT_DIR") {
        p.into()
    } else {
        env::current_dir()?
    })
}
