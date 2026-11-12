use anyhow::{Result, anyhow};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::Path,
    sync::{LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn re(pattern: &str) -> Regex {
    static PATTERNS: LazyLock<Mutex<HashMap<String, Regex>>> = LazyLock::new(Mutex::default);
    PATTERNS
        .lock()
        .expect("Scan regex cache lock poisoned")
        .entry(pattern.into())
        .or_insert_with(|| Regex::new(pattern).expect("Invalid built-in Scan pattern"))
        .clone()
}

pub(super) fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub(super) fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(super) fn clip(text: &str, limit: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= limit
        })
        .collect()
}
pub(super) fn hash(bytes: impl AsRef<[u8]>) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes.as_ref())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(super) fn valid_id(id: &str) -> bool {
    re(r"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$").is_match(id)
}
pub(super) fn read(file: &Path) -> Value {
    fs::read(file)
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or(Value::Null)
}

pub(super) fn write(file: &Path, bytes: &[u8], private: bool) -> Result<()> {
    let parent = file
        .parent()
        .ok_or_else(|| anyhow!("Invalid Scan destination"))?;
    mkdir(parent, private)?;
    let temporary = parent.join(format!(".scan-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if private { 0o600 } else { 0o644 });
        }
        let mut output = options.open(&temporary)?;
        output.write_all(bytes)?;
        fs::rename(&temporary, file)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub(super) fn write_json(file: &Path, value: &Value, private: bool) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write(file, &bytes, private)
}
pub(super) fn mkdir(path: &Path, private: bool) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(if private { 0o700 } else { 0o755 });
    }
    builder.create(path)?;
    Ok(())
}

// RFC3339 milliseconds, shared with the earlier native implementation.
pub(super) fn now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let z = (ms / 86_400_000) as i64 + 719468;
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
