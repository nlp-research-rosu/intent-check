use super::*;
use anyhow::ensure;
use std::fs::{File, OpenOptions};

pub(super) fn private_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
pub(super) fn read(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .filter(Value::is_object)
        .unwrap_or(json!({}))
}
pub(super) fn write(path: &Path, value: &Value, private: bool) -> Result<()> {
    let parent = path.parent().context("State path has no parent")?;
    if private {
        private_dir(parent)?;
    } else {
        fs::create_dir_all(parent)?;
    }
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        id()
    ));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if private { 0o600 } else { 0o644 });
        }
        let mut out = options.open(&temp)?;
        out.write_all(serde_json::to_vec_pretty(value)?.as_slice())?;
        out.flush()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
pub(super) fn append(path: &Path, private: bool) -> Result<File> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        ensure!(
            meta.is_file() && !meta.is_symlink(),
            "Expected a regular log file"
        );
    }
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if private { 0o600 } else { 0o644 });
    }
    Ok(options.open(path)?)
}
pub(super) fn update<T>(
    path: &Path,
    default: Value,
    f: impl FnOnce(&mut Value) -> Result<T>,
) -> Result<T> {
    private_dir(path.parent().context("Missing state directory")?)?;
    // Kernel locks are released even when a hook is killed. Never hold one across network I/O.
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(path.with_extension("native-lock"))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(e.into()),
        }
    }
    let mut value = read(path);
    for (key, item) in default.as_object().context("Invalid state default")? {
        if value.get(key).is_none() {
            value[key] = item.clone();
        }
    }
    let result = f(&mut value)?;
    write(path, &value, true)?;
    Ok(result)
}
pub(super) fn empty() -> Value {
    json!({"v":1,"prompts":[],"prompt_ids":[],"first_prompt":null,"first_prompt_id":null,"prompt_count":0,"turn_id":null,"plan":null,"todos":[],"touched":[],"patches":{},"baseline":null,"pending":[],"edit_jobs":{},"owner":null,"notes":[],"wakes":[],"woken":{},"flags":{},"edit_reserved":{},"edit_pending":{}})
}
pub(super) fn session(data: &Path, key: &str) -> Value {
    let mut value = read(&data.join("sessions").join(format!("{key}.json")));
    for (key, item) in empty().as_object().expect("Session default is an object") {
        if value.get(key).is_none() {
            value[key] = item.clone();
        }
    }
    value
}
pub(super) fn key(payload: &Value) -> String {
    let session = payload["session_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("default");
    hash(format!("intent-session:{session}"))[..32].to_owned()
}
pub(super) fn data_from_root(root: &Path) -> Option<PathBuf> {
    let version = root.file_name()?;
    let _ = version;
    let plugin = root.parent()?;
    let market = plugin.parent()?;
    let cache = market.parent()?;
    if cache.file_name()? != "cache" || cache.parent()?.file_name()? != "plugins" {
        return None;
    }
    Some(cache.parent()?.join("data").join(format!(
        "{}-{}",
        plugin.file_name()?.to_string_lossy(),
        market.file_name()?.to_string_lossy()
    )))
}
pub(super) fn push(value: &mut Value, item: Value, max: usize) {
    if !value.is_array() {
        *value = json!([]);
    }
    let items = value.as_array_mut().expect("Array initialized");
    items.push(item);
    if items.len() > max {
        items.drain(..items.len() - max);
    }
}
pub(super) fn unique(value: &mut Value, item: Value, max: usize) {
    if !array(value).contains(&item) {
        push(value, item, max);
    }
}
pub(super) fn remove(value: &mut Value, key: &str) {
    if let Some(map) = value.as_object_mut() {
        map.remove(key);
    }
}
pub(super) fn note(s: &mut Value, text: &str, user: bool, kind: &str, once: Option<&str>) {
    if let Some(once) = once {
        if !s["flags"]["notes_once"][once].is_null() {
            return;
        }
        if !s["flags"]["notes_once"].is_object() {
            s["flags"]["notes_once"] = json!({});
        }
        s["flags"]["notes_once"][once] = json!(now());
    }
    push(
        &mut s["notes"],
        json!({"id":id(),"text":text,"user":user,"kind":kind,"at":now()}),
        10,
    );
}
pub(super) fn lease_notes(rt: &Runtime, key: &str, only: Option<&str>) -> Result<Output> {
    let token = id();
    let mut out = Output::default();
    rt.session_mut(key, |s| {
        for note in s["notes"].as_array_mut().context("Invalid notes state")? {
            if only.is_some_and(|kind| {
                if kind == "wake" {
                    note["wake"] != true
                } else {
                    note["kind"] != kind
                }
            }) {
                continue;
            }
            if now().saturating_sub(number(&note["delivering_at"])) < 30000 {
                continue;
            }
            note["delivering_at"] = json!(now());
            note["delivery_token"] = json!(token);
            if rt.host == "codex" && note["kind"] == "quiet" {
                continue;
            }
            out.add(
                if note["user"] == true {
                    note["userText"].as_str().unwrap_or(string(&note["text"]))
                } else {
                    ""
                },
                string(&note["text"]),
            );
        }
        Ok(())
    })?;
    out.acknowledgments
        .push((rt.data.join("sessions").join(format!("{key}.json")), token));
    Ok(out)
}
pub(super) fn ack(file: &Path, token: &str) -> Result<()> {
    update(file, json!({}), |s| {
        if let Some(notes) = s["notes"].as_array_mut() {
            notes.retain(|note| note["delivery_token"] != token);
        }
        if s["delivery_token"] == token {
            s["delivered"] = json!(true);
            s["delivered_at"] = json!(now());
            remove(s, "delivering_at");
        }
        Ok(())
    })
}
pub(super) fn alive(pid: u64) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == u64::from(std::process::id()) {
        return true;
    }
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
    }
}

pub(super) fn gc(rt: &Runtime) -> Result<()> {
    let run = rt.global_mut(|g| {
        if now().saturating_sub(number(&g["last_gc"])) < 86400000 {
            return Ok(false);
        }
        g["last_gc"] = json!(now());
        Ok(true)
    })?;
    if !run {
        return Ok(());
    }
    for (folder, ttl) in [
        ("sessions", 30 * 86400000),
        ("tmp", 3600000),
        ("shadow", 30 * 86400000),
        ("deepscans", 7 * 86400000),
    ] {
        let Ok(entries) = fs::read_dir(rt.data.join(folder)) else {
            continue;
        };
        for entry in entries.flatten().take(200000) {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_symlink() {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(now());
            if now().saturating_sub(modified) <= ttl {
                continue;
            }
            if folder == "shadow" {
                if meta.is_dir()
                    && re(r"^[0-9a-f]{32}$").is_match(&entry.file_name().to_string_lossy())
                {
                    let _ = fs::remove_dir_all(&path);
                }
            } else if meta.is_file() {
                if folder == "deepscans" {
                    let scan = read(&path);
                    let age = now().saturating_sub(parse_time(&scan["created_at"]));
                    let wait = number(&scan["budget_s"]).min(86400) * 1000 + 1800000;
                    if scan["delivered"] != true && age <= 86400000.max(wait + 3600000) {
                        continue;
                    }
                }
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}
