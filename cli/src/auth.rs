use crate::{CommandResult, config};
use anyhow::{Context, Result, anyhow, bail};
use reqwest::{Url, blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Default, Deserialize, Serialize)]
struct Credentials {
    keys: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Connection {
    device_code: String,
    user_code: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct Poll {
    status: String,
    api_key: Option<String>,
}

fn origin(address: &str) -> Result<String> {
    let url = Url::parse(address).context("Invalid server or portal URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        bail!("Credentials require HTTPS, or HTTP on localhost");
    }
    Ok(url.origin().ascii_serialization())
}

fn file() -> Result<PathBuf> {
    Ok(config::directory()?.join("credentials.json"))
}

fn read(path: &Path) -> Result<Credentials> {
    if !path.exists() {
        return Ok(Credentials::default());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
            bail!("Credential files must be readable only by their owner");
        }
    }
    serde_json::from_slice(&fs::read(path)?)
        .map_err(|_| anyhow!("Invalid credential file; its contents have not been printed"))
}

fn write(path: &Path, value: &Credentials) -> Result<()> {
    let directory = path.parent().unwrap();
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    let temporary = directory.join(format!(".credential-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        output.write_all(&serde_json::to_vec(value)?)?;
        output.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn api_key(server: &str) -> Result<Option<String>> {
    if let Ok(key) = std::env::var("INTENT_API_KEY")
        && !key.trim().is_empty()
    {
        return Ok(Some(key.trim().into()));
    }
    let server_origin = Url::parse(server)?.origin().ascii_serialization();
    let key = read(&file()?)?.keys.remove(&server_origin);
    if key.is_some() {
        origin(server)?;
    }
    Ok(key)
}

fn request<T: DeserializeOwned>(http: &Client, endpoint: &str, body: Value) -> Result<T> {
    let response = http
        .post(endpoint)
        .json(&body)
        .send()
        .map_err(|_| anyhow!("The login portal could not be reached"))?;
    if !response.status().is_success() {
        bail!("The login portal returned HTTP {}", response.status());
    }
    response
        .json()
        .map_err(|_| anyhow!("The login portal returned an invalid response"))
}

pub fn login() -> CommandResult {
    let config = config::load()?;
    let server_origin = origin(&config.server_url)?;
    let portal_origin = origin(&config.portal_url)?;
    let endpoint = format!("{portal_origin}/api/cli-connect");
    let http = Client::builder()
        .timeout(Duration::from_secs(config.request_timeout_seconds))
        .redirect(Policy::none())
        .build()?;
    let connection: Connection = request(&http, &endpoint, json!({"action": "start"}))?;
    if connection.device_code.is_empty()
        || connection.user_code.is_empty()
        || !(1..=900).contains(&connection.expires_in)
        || !(1..=30).contains(&connection.interval)
    {
        bail!("The login portal returned an invalid connection");
    }
    println!(
        "{}",
        json!({
            "status": "pending",
            "verification_url": format!("{portal_origin}/connect/{}", connection.user_code),
            "user_code": connection.user_code,
            "expires_in": connection.expires_in,
        })
    );
    std::io::stdout().flush()?;

    let deadline = Instant::now() + Duration::from_secs(connection.expires_in);
    let mut failures = 0;
    while Instant::now() < deadline {
        // A network blip, 5xx or 429 must not end a login the user is still approving.
        let response = match request(
            &http,
            &endpoint,
            json!({"action": "poll", "device_code": connection.device_code}),
        ) {
            Ok(response) => {
                failures = 0;
                response
            }
            Err(error) => {
                failures += 1;
                if failures >= 40 {
                    return Err(error);
                }
                Poll {
                    status: "pending".into(),
                    api_key: None,
                }
            }
        };
        match response.status.as_str() {
            "pending" => {}
            "approved" => {
                let key = response
                    .api_key
                    .as_deref()
                    .filter(|key| {
                        !key.is_empty() && key.len() <= 256 && !key.chars().any(char::is_control)
                    })
                    .ok_or_else(|| {
                        anyhow!("The login response did not include a valid credential")
                    })?;
                let path = file()?;
                let mut credentials = read(&path)?;
                credentials.keys.insert(server_origin, key.into());
                write(&path, &credentials)?;
                return Ok((0, json!({"status": "connected"})));
            }
            status @ ("denied" | "expired" | "consumed" | "failed") => {
                return Ok((1, json!({"status": status})));
            }
            _ => bail!("The login portal returned an invalid connection status"),
        }
        thread::sleep(
            Duration::from_secs(connection.interval)
                .min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    Ok((1, json!({"status": "expired"})))
}
