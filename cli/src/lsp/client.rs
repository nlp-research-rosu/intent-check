use super::ServerConfig;
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

// Bounds an analyzer response, not the overall number of files or queries.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
// Allow consecutive work-done tasks to arrive; this is an idle hint, not a readiness guarantee.
const PROGRESS_QUIET: Duration = Duration::from_millis(200);

#[derive(Debug, Deserialize)]
pub(super) struct ResponseError {
    code: i64,
    message: String,
}

impl std::fmt::Display for ResponseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} (code {})", self.message, self.code)
    }
}

impl std::error::Error for ResponseError {}

pub(super) struct Client {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Result<Value>>,
    next_id: u64,
    settings: Value,
    interrupted: fn() -> bool,
    work: BTreeSet<String>,
    work_generation: u64,
}

impl Client {
    pub(super) fn start(
        executable: &Path,
        root: &Path,
        config: &ServerConfig,
        interrupted: fn() -> bool,
    ) -> Result<(Self, Value)> {
        let mut child = Command::new(executable)
            .args(&config.command[1..])
            .envs(&config.env)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("starting configured language server")?;
        let stdin = child.stdin.take().context("language server has no stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("language server has no stdout")?;
        let (send, messages) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = read_message(&mut reader);
                let failed = message.is_err();
                if send.send(message).is_err() || failed {
                    break;
                }
            }
        });
        let mut client = Self {
            child,
            stdin,
            messages,
            next_id: 0,
            settings: config.settings.clone(),
            interrupted,
            work: BTreeSet::new(),
            work_generation: 0,
        };
        let uri = super::uri(root)?;
        let result = client.request(
            "initialize",
            json!({
                "processId": std::process::id(), "rootUri": uri,
                "workspaceFolders": [{"uri": uri, "name": root.file_name().and_then(|s| s.to_str()).unwrap_or("project")}],
                "capabilities": {
                    "general": {"positionEncodings": ["utf-16"]},
                    "workspace": {"configuration": true, "workspaceFolders": true},
                    "window": {"workDoneProgress": true},
                    "textDocument": {
                        "documentSymbol": {"hierarchicalDocumentSymbolSupport": true,
                            "symbolKind": {"valueSet": (1..=26).collect::<Vec<u32>>() }},
                        "callHierarchy": {}, "references": {}
                    }
                },
                "initializationOptions": config.initialization
            }),
        )?;
        ensure!(
            result["capabilities"]["positionEncoding"]
                .as_str()
                .is_none_or(|s| s == "utf-16"),
            "language server selected an unsupported position encoding"
        );
        client.notify("initialized", json!({}))?;
        client.notify(
            "workspace/didChangeConfiguration",
            json!({"settings": config.settings}),
        )?;
        Ok((client, result))
    }

    pub(super) fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))?;
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        loop {
            ensure!(!(self.interrupted)(), "LSP collection interrupted");
            let remaining = deadline.saturating_duration_since(Instant::now());
            ensure!(!remaining.is_zero(), "LSP request timed out: {method}");
            let message = match self
                .messages
                .recv_timeout(remaining.min(Duration::from_millis(100)))
            {
                Ok(message) => message?,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => bail!("language server disconnected"),
            };
            if message.get("method").is_some() {
                self.server_request(&message)?;
                continue;
            }
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(anyhow::Error::new(serde_json::from_value::<ResponseError>(
                    error.clone(),
                )?))
                .with_context(|| format!("LSP {method} failed"));
            }
            return message
                .get("result")
                .cloned()
                .context("LSP response has no result");
        }
    }

    pub(super) fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.send(json!({"jsonrpc":"2.0", "method":method, "params":params}))
    }

    pub(super) fn wait_for_idle(&mut self) -> Result<u64> {
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        let mut quiet_since = Instant::now();
        loop {
            ensure!(!(self.interrupted)(), "LSP collection interrupted");
            let remaining = deadline.saturating_duration_since(Instant::now());
            ensure!(
                !remaining.is_zero(),
                "Language server work did not settle before timeout"
            );
            if self.work.is_empty() && quiet_since.elapsed() >= PROGRESS_QUIET {
                return Ok(self.work_generation);
            }
            match self
                .messages
                .recv_timeout(remaining.min(Duration::from_millis(50)))
            {
                Ok(message) => {
                    let message = message?;
                    if matches!(
                        message["method"].as_str(),
                        Some("$/progress" | "window/workDoneProgress/create")
                    ) {
                        quiet_since = Instant::now();
                    }
                    if message.get("method").is_some() {
                        self.server_request(&message)?;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => bail!("language server disconnected"),
            }
        }
    }

    fn send(&mut self, message: Value) -> Result<()> {
        let body = serde_json::to_vec(&message)?;
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len())?;
        self.stdin.write_all(&body)?;
        self.stdin.flush()?;
        Ok(())
    }

    fn server_request(&mut self, message: &Value) -> Result<()> {
        if message["method"] == "$/progress" {
            let token = serde_json::to_string(&message["params"]["token"])?;
            match message["params"]["value"]["kind"].as_str() {
                Some("begin") => {
                    self.work.insert(token);
                    self.work_generation += 1;
                }
                Some("end") => {
                    self.work.remove(&token);
                }
                _ => {}
            }
        }
        let Some(id) = message.get("id") else {
            return Ok(());
        };
        match message["method"].as_str() {
            Some("workspace/configuration") => {
                let items = message["params"]["items"].as_array().context("invalid configuration request")?;
                let values: Vec<_> = items.iter().map(|item| {
                    item["section"].as_str().filter(|s| !s.is_empty()).map_or_else(
                        || self.settings.clone(),
                        |section| section.split('.').fold(&self.settings, |v, key| &v[key]).clone(),
                    )
                }).collect();
                self.send(json!({"jsonrpc":"2.0", "id":id, "result":values}))
            }
            Some("client/registerCapability" | "client/unregisterCapability" | "window/workDoneProgress/create") => {
                self.send(json!({"jsonrpc":"2.0", "id":id, "result":null}))
            }
            _ => self.send(json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32601, "message":"unsupported client request"}})),
        }
    }

    pub(super) fn shutdown(mut self) -> Result<()> {
        self.request("shutdown", Value::Null)?;
        self.notify("exit", Value::Null)?;
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait()? {
                ensure!(status.success(), "language server exited with {status}");
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
        bail!("language server did not exit after shutdown; terminating it")
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_message(reader: &mut impl BufRead) -> Result<Value> {
    let mut length = None;
    loop {
        let mut line = String::new();
        ensure!(
            reader.read_line(&mut line)? != 0,
            "language server closed stdout"
        );
        if line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("Content-Length")
        {
            length = Some(value.trim().parse::<usize>()?);
        }
    }
    let length = length.context("LSP message has no Content-Length")?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}
