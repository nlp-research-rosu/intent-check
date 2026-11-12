//! Explicit repository Scan submission and interrupted-task recovery.
mod http;
mod redact;
mod render;
mod snapshot;
mod store;
mod support;

use crate::{auth, channel, config};
use anyhow::{Context, Result, bail, ensure};
use clap::{Args, ValueEnum};
use http::Api;
use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use support::{now, read, string, valid_id, write_json};

#[derive(Args)]
pub(crate) struct ScanArgs {
    /// One file or folder and optional fast, balanced or full depth; or collect and an optional task ID.
    pub words: Vec<String>,
    #[command(flatten)]
    pub plugin: PluginArgs,
}

#[derive(Args)]
pub(crate) struct PluginArgs {
    /// Existing plugin data directory for local Scan recovery records.
    #[arg(long)]
    data: Option<PathBuf>,
    /// Plugin installation directory; used only to locate its existing data directory.
    #[arg(long)]
    plugin_root: Option<PathBuf>,
    /// Host recorded in the Scan snapshot.
    #[arg(long, value_enum, default_value_t = Host::ClaudeCode)]
    host: Host,
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
pub(crate) enum Host {
    #[default]
    ClaudeCode,
    Codex,
}
impl Host {
    fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
enum Depth {
    #[default]
    Fast,
    Balanced,
    Full,
}
impl Depth {
    fn parse(word: &str) -> Option<Self> {
        match word.to_ascii_lowercase().as_str() {
            "fast" => Some(Self::Fast),
            "balanced" => Some(Self::Balanced),
            "full" => Some(Self::Full),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Balanced => "balanced",
            Self::Full => "full",
        }
    }
    fn time(self) -> &'static str {
        match self {
            Self::Fast => "15 to 20 min",
            Self::Balanced => "30 to 35 min",
            Self::Full => "40 to 45 min",
        }
    }
}

fn data_dir(args: &PluginArgs) -> Result<PathBuf> {
    if let Some(data) = args
        .data
        .as_ref()
        .filter(|p| !p.to_string_lossy().contains("${"))
    {
        return Ok(data.clone());
    }
    for name in ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"] {
        if let Some(data) = env::var_os(name).filter(|s| !s.is_empty()) {
            return Ok(PathBuf::from(data));
        }
    }
    let root = args
        .plugin_root
        .clone()
        .or_else(|| env::var_os("CLAUDE_PLUGIN_ROOT").map(PathBuf::from));
    if let Some(root) = root {
        let root = snapshot::canonical(&root)?;
        // Installed cache layout: plugins/cache/<marketplace>/<plugin>/<version>.
        if let Some(cache) = root.ancestors().nth(3)
            && cache.file_name().is_some_and(|s| s == "cache")
            && cache
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|s| s == "plugins")
        {
            let plugin = root
                .parent()
                .and_then(Path::file_name)
                .context("Plugin cache name")?
                .to_string_lossy();
            let marketplace = root
                .ancestors()
                .nth(2)
                .and_then(Path::file_name)
                .context("Plugin marketplace name")?
                .to_string_lossy();
            return Ok(cache
                .parent()
                .context("Plugin cache parent")?
                .join("data")
                .join(format!("{plugin}-{marketplace}")));
        }
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .context("HOME is not set")?;
    let c = channel::settings();
    Ok(PathBuf::from(home)
        .join(".claude/plugins/data")
        .join(format!("{}-{}", c.plugin, c.marketplace)))
}
fn disabled() -> Option<&'static str> {
    ["INTENT_DISABLED", "DO_NOT_TRACK"]
        .into_iter()
        .find(|name| env::var(name).is_ok_and(|s| s == "1"))
}
fn access(config: config::Config) -> Result<Api> {
    if let Some(reason) = disabled() {
        bail!("{reason}=1 is set; remove it to use plugin Scan commands.");
    }
    let key = auth::api_key(&config.server_url).ok().flatten().filter(|k| !k.is_empty()).with_context(|| format!("Not connected. Use onboarding to install the global CLI if needed, then run {} login.", channel::settings().cli))?;
    Api::new(config, key)
}
fn record_file(data: &Path, id: &str) -> Result<PathBuf> {
    ensure!(valid_id(id), "Invalid Scan task ID");
    Ok(data.join("scans").join(format!("{id}.json")))
}
fn save(data: &Path, scan: &Value) -> Result<()> {
    write_json(&record_file(data, string(&scan["job_id"]))?, scan, true)
}
fn merge(scan: &mut Value, progress: Value) {
    if let (Some(scan), Some(progress)) = (scan.as_object_mut(), progress.as_object()) {
        scan.extend(progress.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
}

pub(crate) fn run(args: ScanArgs) -> Result<String> {
    let cwd = env::current_dir()?;
    let config = config::load()?;
    let data = data_dir(&args.plugin)?;
    if args.words.first().is_some_and(|s| s == "collect") {
        ensure!(args.words.len() <= 2, "Use: scan collect [task-id]");
        return collect(args.words.get(1).map(String::as_str), &cwd, &data, config);
    }
    if let Some(flag) = args.words.iter().find(|s| s.starts_with("--")) {
        let c = channel::settings();
        return Ok(format!(
            "{}: {flag} is not a Scan option. Use: /{}:scan [file or folder] [fast|balanced|full]",
            c.display_name, c.plugin
        ));
    }
    let depths: Vec<_> = args.words.iter().filter_map(|s| Depth::parse(s)).collect();
    if depths.len() > 1 {
        let words = args
            .words
            .iter()
            .filter(|s| Depth::parse(s).is_some())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        return Ok(format!(
            "Intent Prover: Give one depth, not several ({words}). Choose fast, balanced, full."
        ));
    }
    let targets: Vec<_> = args
        .words
        .iter()
        .filter(|s| Depth::parse(s).is_none())
        .collect();
    if targets.len() > 1 {
        return Ok("Intent Prover: give one file or folder at a time.".into());
    }
    let depth = depths.first().copied().unwrap_or_default();
    let api = access(config)?;
    let snap = match snapshot::build(
        &cwd,
        targets.first().map(|s| s.as_str()),
        args.plugin.host,
        depth,
    ) {
        Ok(snap) => snap,
        Err(error) => return Ok(format!("Intent Prover: {error}")),
    };
    store::prepare(&snap.root, None)?;
    support::mkdir(&data, true)?;
    support::mkdir(&data.join("scans"), true)?;
    let idem = uuid::Uuid::new_v4().simple().to_string();
    let mut response = api.submit(&snap.gz, &idem);
    if response.status == 429
        && response.code() == "RATE_LIMITED"
        && let Some(retry) = response.retry_after
    {
        thread::sleep(Duration::from_secs_f64(retry.min(30.)));
        response = api.submit(&snap.gz, &idem);
    }
    if response.status == 0 {
        response = api.submit(&snap.gz, &idem);
    }
    let id = string(&response.body["id"]);
    if response.status != 202 || !valid_id(id) {
        return Ok(format!(
            "Intent Prover: {}",
            http::submit_failure(&api, &response)
        ));
    }
    let url = api.url(id);
    let mut scan = json!({"v":1,"job_id":id,"url":url,"repo_root":snap.root,"created_at":now(),"host":args.plugin.host.as_str(),"scope":snap.source["scope"],"depth":depth.as_str(),"status":"queued","api_url":api.config.server_url,"source":snap.source,"report_status":"pending"});
    save(&data, &scan)?;
    store::metadata(&scan, None, &api)?;
    store::sent_log(
        &snap.root,
        json!({"at":scan["created_at"],"mode":"scan","job_id":id,"url":url,"files":snap.files,"bytes":snap.bytes,"redactions":snap.redactions}),
    );
    let scope = scan["scope"]
        .as_str()
        .map(|s| format!(" in {s}"))
        .unwrap_or_default();
    eprintln!(
        "Intent Prover: Scan ({}, about {}) started on {} file(s){scope}. Remote job: {url}",
        depth.as_str(),
        depth.time(),
        snap.files
    );
    if snap.over > 0 {
        eprintln!(
            "{} file(s) were left out to fit the size caps; scan a smaller folder for coverage.",
            snap.over
        );
    }
    eprintln!("Waiting for results. If interrupted, resume with scan collect {id}.");
    collect_one(&mut scan, &data, &api)
}

fn collect_one(scan: &mut Value, data: &Path, api: &Api) -> Result<String> {
    let id = string(&scan["job_id"]).to_owned();
    let mut failures = 0;
    let response = loop {
        let response = api.task(&id);
        if response.status != 200 {
            if response.retryable() && failures < 3 {
                let delay = 1 << failures;
                failures += 1;
                eprintln!(
                    "Intent Prover: status request failed ({}); retrying in {delay}s ({failures}/3).",
                    response.code()
                );
                thread::sleep(Duration::from_secs(delay));
                continue;
            }
            if response.code() == "ACCESS_NOT_APPROVED" {
                bail!("Scan {id}: {}", api.not_approved());
            }
            bail!(
                "Scan {id}: status unavailable ({}). The task may still be running; resume with scan collect {id}. {}",
                response.code(),
                string(&scan["url"])
            );
        }
        failures = 0;
        let progress = http::progress(&response.body);
        if !["queued", "running"].contains(&string(&progress["status"])) {
            merge(scan, progress);
            break response;
        }
        if scan["status"] != progress["status"] {
            eprintln!(
                "Scan {id}: {} · {}",
                string(&progress["status"]),
                string(&scan["url"])
            );
        }
        merge(scan, progress);
        save(data, scan)?;
        store::metadata(scan, Some(&response.body), api)?;
        thread::sleep(Duration::from_secs(api.config.poll_interval_seconds));
    };
    let mut lines = Vec::new();
    if scan["status"] == "done" {
        let report = store::report(scan, &response.body, api)?;
        scan["report_status"] = report["status"].clone();
        scan["report_error"] = report["reason"].clone();
        if report["status"] != "pending" {
            scan["collected_at"] = json!(now());
        }
        lines.push(render::scan(scan));
        lines.push(if report["status"] == "saved" {
            format!("Saved report: .intent/scan/{id}/report.json")
        } else {
            format!(
                "Report {}{}; use collect again to retry.",
                string(&report["status"]),
                report["reason"]
                    .as_str()
                    .map(|s| format!(" ({s})"))
                    .unwrap_or_default()
            )
        });
    } else {
        scan["report_status"] = json!("unavailable");
        scan["collected_at"] = json!(now());
        lines.push(if scan["status"] == "failed" {
            render::scan(scan)
        } else {
            format!(
                "Scan {id}: {} · {}",
                string(&scan["status"]),
                string(&scan["url"])
            )
        });
    }
    save(data, scan)?;
    store::metadata(scan, Some(&response.body), api)?;
    lines.push(format!("Local HTML report: from the repository root, run {} view --output <new-file.html>. Present that HTML link first; open it at #view=scans&scan=scan%2F{id}%2Fmeta.json. The remote job link is inside.",channel::settings().cli));
    let result = lines.join("\n");
    ensure!(scan["status"] == "done", "{result}");
    Ok(result)
}

fn collect(id: Option<&str>, cwd: &Path, data: &Path, config: config::Config) -> Result<String> {
    ensure!(id.is_none_or(valid_id), "Use: scan collect [task-id]");
    let root = snapshot::root(cwd).unwrap_or(snapshot::canonical(cwd)?);
    let mut records: Vec<_> = fs::read_dir(data.join("scans"))
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|s| s == "json"))
        .collect();
    records.sort();
    let mut scans = Vec::new();
    for path in records {
        let record = read(&path);
        let task = string(&record["job_id"]);
        if !valid_id(task) || path.file_stem().is_none_or(|s| s != task) {
            continue;
        }
        if record["repo_root"]
            .as_str()
            .is_none_or(|s| Path::new(s) != root)
            || record["api_url"]
                .as_str()
                .is_some_and(|s| s != config.server_url)
        {
            continue;
        }
        if id.map_or(
            record["collected_at"].is_null() || record["report_status"] == "pending",
            |id| id == task,
        ) {
            scans.push(record);
        }
    }
    if scans.is_empty() {
        return Ok(if id.is_some() { "No local Scan record for that task in this project and service." } else { "No uncollected scans in this project. Use a task ID to collect an earlier result again." }.into());
    }
    let api = access(config)?;
    let (mut lines, mut failed) = (Vec::new(), false);
    for mut scan in scans {
        match collect_one(&mut scan, data, &api) {
            Ok(text) => lines.push(text),
            Err(error) => {
                failed = true;
                let id = string(&scan["job_id"]);
                lines.push(format!(
                    "Scan {id}: could not collect ({}). Retry with scan collect {id}. {}",
                    render::sanitize(&error.to_string(), 600),
                    string(&scan["url"])
                ));
            }
        }
    }
    let result = lines.join("\n\n");
    ensure!(!failed, "{result}");
    Ok(result)
}

pub(crate) fn doctor(args: PluginArgs) -> Result<String> {
    let config = config::load()?;
    let key = auth::api_key(&config.server_url);
    let problem = key.as_ref().err().map(ToString::to_string);
    let key = key.ok().flatten();
    let env_key = env::var(channel::env_name("API_KEY")).is_ok_and(|s| !s.trim().is_empty());
    let account = if let Some(key) = key.as_ref() {
        let api = Api::new(config.clone(), key.clone())?;
        let response = api.request("/tasks?limit=1", None, None, 3000, false);
        if response.status == 200 {
            "key accepted".into()
        } else if response.status == 401 {
            format!("key rejected; run {} login", channel::settings().cli)
        } else if response.code() == "ACCESS_NOT_APPROVED" {
            api.not_approved()
        } else {
            "could not reach the service".into()
        }
    } else {
        format!("not connected; run {} login", channel::settings().cli)
    };
    let source = if env_key {
        channel::env_name("API_KEY")
    } else if key.is_some() {
        config::directory()?
            .join("credentials.json")
            .display()
            .to_string()
    } else {
        "none".into()
    };
    let mut lines = vec![
        format!(
            "{} v{}: explicit Scan and Prove",
            channel::settings().display_name,
            env!("CARGO_PKG_VERSION")
        ),
        format!("Service: {}", config.server_url),
        format!("Account: {account}"),
        format!("Key source: {source}"),
        format!("Local Scan state: {}", data_dir(&args)?.display()),
        "Automatic hooks and reviews: none".into(),
    ];
    if let Some(reason) = disabled() {
        lines.push(format!(
            "{reason}=1 blocks plugin Scan commands. Remove it before scanning."
        ));
    }
    if let Some(problem) = problem {
        lines.push(format!("Credentials: {problem}"));
    }
    lines.push(
        "Scan commands wait for results. Resume an interrupted Scan: scan collect [task-id]".into(),
    );
    Ok(lines.join("\n"))
}
