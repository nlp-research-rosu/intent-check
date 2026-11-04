use crate::{ProofArgs, RunArgs, auth, config::Config, inputs, session::Session};
use anyhow::{Context, Result, anyhow, bail};
use reqwest::{
    StatusCode,
    blocking::{Client, RequestBuilder, Response, multipart},
    header::{AUTHORIZATION, HeaderMap, HeaderValue, LOCATION},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
};

pub struct Api {
    base: String,
    http: Client,
    files: Client,
    request_timeout: Duration,
}

pub struct Upload {
    fields: Vec<(&'static str, String)>,
    file: UploadFile,
    inputs: Vec<(String, Vec<u8>)>,
    targets: Vec<Value>,
    requirements: Vec<Value>,
    specification_id: Option<String>,
}

struct UploadFile {
    field: &'static str,
    name: String,
    mime: Option<&'static str>,
    bytes: Vec<u8>,
}

impl Upload {
    fn form(&self) -> Result<multipart::Form> {
        let form = self
            .fields
            .iter()
            .fold(multipart::Form::new(), |form, (name, value)| {
                form.text(*name, value.clone())
            });
        let file = &self.file;
        let mut part = multipart::Part::bytes(file.bytes.clone()).file_name(file.name.clone());
        if let Some(mime) = file.mime {
            part = part.mime_str(mime)?;
        }
        Ok(form.part(file.field, part))
    }
}

struct WaitResult {
    task: Value,
    stop: Option<Value>,
}

// Includes the cancellation request and all confirmation polls.
const CANCELLATION_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_RETRIES: u32 = 3;
const SUBMIT_RETRIES: u32 = 3;

impl Api {
    pub fn new(config: &Config) -> Result<Self> {
        let mut http = Client::builder()
            .timeout(Duration::from_secs(config.request_timeout_seconds))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(key) = auth::api_key(&config.server_url)? {
            let mut value = HeaderValue::from_str(&format!("Bearer {key}"))?;
            value.set_sensitive(true);
            http = http.default_headers(HeaderMap::from_iter([(AUTHORIZATION, value)]));
        }
        Ok(Self {
            base: config.server_url.trim_end_matches('/').into(),
            http: http.build()?,
            files: Client::builder()
                .timeout(Duration::from_secs(config.request_timeout_seconds))
                .build()?,
            request_timeout: Duration::from_secs(config.request_timeout_seconds),
        })
    }

    pub fn health(&self) -> Result<Value> {
        let health = self.get("/healthz")?;
        if health["status"] != "ok" {
            bail!("Intent Prover service health check failed");
        }
        Ok(health)
    }

    pub fn semantics(&self) -> Result<Value> {
        self.get("/semantics")
    }

    pub fn semantics_archive(&self, id: &str) -> Result<Response> {
        let response = self
            .http
            .get(format!("{}/semantics/{id}/archive", self.base))
            .send()?;
        let status = response.status();
        if !status.is_success() {
            bail!(
                "Intent Prover service semantics archive returned HTTP {status}; check the endpoint and saved connection"
            );
        }
        Ok(response)
    }

    pub fn prepare_run(&self, root: &Path, args: RunArgs) -> Result<Upload> {
        let semantics = crate::session::load(args.session)?.semantics;
        crate::semantics::require(&semantics, args.semantics.as_deref())?;
        let (program, name) = inputs::resolve(root, &args.program)?;
        let file_name = Path::new(&name)
            .file_name()
            .ok_or_else(|| anyhow!("Program path has no file name"))?
            .to_string_lossy()
            .into_owned();
        let bytes = fs::read(program)?;
        Ok(Upload {
            fields: vec![
                ("semanticsId", semantics.id),
                ("semanticsCommit", semantics.commit),
            ],
            file: UploadFile {
                field: "programFile",
                name: file_name.clone(),
                mime: None,
                bytes: bytes.clone(),
            },
            inputs: vec![(file_name, bytes)],
            targets: Vec::new(),
            requirements: Vec::new(),
            specification_id: None,
        })
    }

    pub fn submit_run(&self, upload: &Upload) -> Result<Value> {
        self.submit("/runs", upload)
    }

    pub fn submit_validation(&self, upload: &Upload) -> Result<Value> {
        self.submit("/proof-dry-runs", upload)
    }

    pub fn submit_proof(&self, upload: &Upload) -> Result<Value> {
        self.submit("/proofs", upload)
    }

    pub fn complete(
        &self,
        accepted: &Value,
        poll: u64,
        evidence: PathBuf,
        session: &Session,
    ) -> Result<Value> {
        let id = task_id(accepted)?;
        let waited = self.wait(accepted, poll, &evidence);
        let mut snapshot = fs::read(evidence.join("result.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({"task": accepted}));
        let task = match &waited {
            Ok(waited) => waited.task.clone(),
            Err(_) => snapshot["task"].clone(),
        };
        snapshot["task"] = task.clone();
        if let Ok(WaitResult {
            stop: Some(stop), ..
        }) = &waited
        {
            snapshot["wait"] = stop.clone();
        }
        write_json(&evidence, "result.json", &snapshot)?;
        self.add_metrics(id, &mut snapshot);
        for stream in ["stdout", "stderr"] {
            let error_field = format!("{stream}Error");
            match self.log(id, stream) {
                Ok(log) => {
                    snapshot[stream] = json!(String::from_utf8_lossy(&log));
                    snapshot.as_object_mut().unwrap().remove(&error_field);
                }
                Err(error) => {
                    snapshot[&error_field] = json!(error.to_string());
                    if snapshot[stream].is_null() {
                        snapshot[stream] = json!(format!("Log unavailable: {error}\n"));
                    }
                }
            }
        }
        write_json(&evidence, "result.json", &snapshot)?;
        let waited = waited.map_err(|error| {
            anyhow!(
                "Task {id}: {error}; evidence: {}; resume with intent-prover task wait {id} --session {}",
                evidence.display(), session.session_id
            )
        })?;
        let semantics = &session.semantics;
        if [accepted, &task].iter().any(|response| {
            response["semantics"]["id"] != semantics.id
                || response["semantics"]["commit"] != semantics.commit
        }) {
            bail!(
                "Task {id} semantics identity is missing or mismatched; evidence: {}",
                evidence.display()
            );
        }
        if let Some(stop) = waited.stop {
            let message = stop["message"].as_str().unwrap_or("Task wait stopped");
            bail!("{message}; evidence: {}", evidence.display());
        }
        let successful = task["status"] == "completed"
            && task["error"].is_null()
            && matches!(
                task["result"].as_str(),
                Some("proved" | "valid" | "success")
            )
            && task["toolRuns"]
                .as_array()
                .and_then(|runs| runs.last())
                .is_none_or(|run| run["exitCode"] == 0);
        crate::storage::finish_properties(&session.project_root, &evidence, successful)?;
        Ok(task)
    }

    pub fn prepare_proof(
        &self,
        root: &Path,
        args: ProofArgs,
        depth: Option<u64>,
    ) -> Result<Upload> {
        let proof_session = crate::session::load(args.session)?;
        let semantics = proof_session.semantics;
        let mut targets = Vec::new();
        for target in &args.target {
            let (path, symbol) = target
                .split_once("::")
                .map_or((target.as_str(), None), |(p, s)| (p, Some(s)));
            crate::requirements::relative_path(path)?;
            anyhow::ensure!(
                symbol.is_none_or(|s| !s.trim().is_empty() && !s.chars().any(char::is_control)),
                "Invalid target symbol"
            );
            let (file, _) = inputs::resolve(&proof_session.project_root, Path::new(path))?;
            targets.push(json!({"path":path,"symbol":symbol,"source_sha256":crate::storage::hash(fs::read(file)?)}));
        }
        let context = crate::storage::collect(&proof_session.project_root, &[])?;
        let mut requirements = Vec::new();
        for id in &args.requirement {
            let record = context["requirements"]
                .as_array()
                .context("Missing requirements")?
                .iter()
                .find(|r| r["id"] == *id)
                .ok_or_else(|| anyhow!("Unknown requirement ID: {id}"))?;
            requirements.push(
                json!({"id":id,"record_sha256":crate::storage::hash(serde_json::to_vec(record)?)}),
            );
        }
        crate::semantics::require(&semantics, args.semantics.as_deref())?;
        let (_, spec_name) = inputs::resolve_proof(root, &args.spec)?;
        let verification_name = args
            .verification
            .as_ref()
            .map(|file| inputs::resolve_proof(root, file).map(|(_, name)| name))
            .transpose()?;
        let mut sources = args.source;
        sources.push(args.spec);
        if let Some(file) = args.verification {
            sources.push(file);
        }
        let files = inputs::load(root, &sources)?;
        if let Some(id) = &args.spec_id {
            anyhow::ensure!(
                crate::storage::valid_id(id),
                "Expected a six-character specification ID"
            );
        }
        let mut fields = vec![
            ("semanticsId", semantics.id),
            ("semanticsCommit", semantics.commit),
            ("specEntryFile", spec_name),
            ("specModule", args.spec_module),
        ];
        if let Some(name) = verification_name {
            fields.push(("verificationEntryFile", name));
            fields.push((
                "verificationModule",
                args.verification_module
                    .ok_or_else(|| anyhow!("Missing verification module"))?,
            ));
        }
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in &files {
            if name.chars().any(|c| c == '"' || c.is_control()) {
                bail!("Unsupported characters in upload path: {name:?}");
            }
            archive.start_file(name.as_str(), options)?;
            archive.write_all(bytes)?;
        }
        for (field, values) in [
            ("claim", args.claim),
            ("excludeClaim", args.exclude_claim),
            ("trusted", args.trusted),
        ] {
            fields.extend(values.into_iter().map(|value| (field, value)));
        }
        if let Some(depth) = depth {
            fields.push(("depth", depth.to_string()));
        }
        Ok(Upload {
            fields,
            file: UploadFile {
                field: "specArchive",
                name: "spec.zip".into(),
                mime: Some("application/zip"),
                bytes: archive.finish()?.into_inner(),
            },
            inputs: files.into_iter().collect(),
            specification_id: args.spec_id,
            targets,
            requirements,
        })
    }

    // One key per logical submission: a retry after a timeout or 5xx
    // replays the task the first attempt may have created.
    fn submit(&self, path: &str, upload: &Upload) -> Result<Value> {
        let key = uuid::Uuid::new_v4().to_string();
        let mut failures = 0;
        loop {
            let request = self
                .http
                .post(format!("{}{path}", self.base))
                .header("Idempotency-Key", &key)
                .multipart(upload.form()?);
            match self.json(request) {
                Ok(value) => {
                    task_id(&value)?;
                    return Ok(value);
                }
                Err(error) if retryable_error(&error) && failures < SUBMIT_RETRIES => {
                    failures += 1;
                    let delay = Duration::from_secs(1 << (failures - 1));
                    eprintln!(
                        "{path}: {error}; retrying submission in {}s ({failures}/{SUBMIT_RETRIES})",
                        delay.as_secs()
                    );
                    std::thread::sleep(delay);
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn wait(&self, accepted: &Value, poll: u64, evidence: &Path) -> Result<WaitResult> {
        let id = task_id(accepted)?;
        let (interrupt, signal) = mpsc::channel();
        ctrlc::set_handler(move || {
            let _ = interrupt.send(());
        })?;
        let mut snapshot = fs::read(evidence.join("result.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({"task": accepted}));
        let mut failures = 0;
        loop {
            if signal.try_recv().is_ok() {
                return Ok(self.stop(id, snapshot["task"].clone(), "interrupted"));
            }
            let task = match self.task(id) {
                Ok(task) => task,
                Err(error) => {
                    failures += 1;
                    let retry = retryable_error(&error) && failures <= POLL_RETRIES;
                    snapshot["wait"] = json!({"reason": "polling_error", "taskId": id,
                        "error": error.to_string(), "retrying": retry,
                        "consecutiveFailures": failures});
                    write_json(evidence, "result.json", &snapshot)?;
                    if !retry {
                        return Err(error);
                    }
                    let delay = Duration::from_secs(1 << (failures - 1));
                    eprintln!(
                        "Task {id}: {error}; retrying poll in {}s ({failures}/{POLL_RETRIES})",
                        delay.as_secs()
                    );
                    if signal.recv_timeout(delay).is_ok() {
                        return Ok(self.stop(id, snapshot["task"].clone(), "interrupted"));
                    }
                    continue;
                }
            };
            if task_id(&task)? != id {
                bail!("Intent Prover service response task ID is mismatched");
            }
            failures = 0;
            snapshot.as_object_mut().unwrap().remove("wait");
            snapshot["task"] = task.clone();
            self.add_metrics(id, &mut snapshot);
            write_json(evidence, "result.json", &snapshot)?;
            if task["semantics"] != accepted["semantics"] {
                bail!("Task {id} semantics identity is missing or mismatched");
            }
            match task["status"].as_str() {
                Some("completed" | "failed" | "timed_out" | "cancelled" | "data_expired") => {
                    return Ok(WaitResult { task, stop: None });
                }
                Some("queued" | "running") => {}
                status => bail!("Unknown Intent Prover service task status: {status:?}"),
            }
            if signal.recv_timeout(Duration::from_secs(poll)).is_ok() {
                return Ok(self.stop(id, task, "interrupted"));
            }
        }
    }

    fn stop(&self, id: &str, mut task: Value, reason: &str) -> WaitResult {
        let deadline = Instant::now() + CANCELLATION_TIMEOUT;
        let request = self.cancel(id, self.request_timeout.min(CANCELLATION_TIMEOUT));
        let (request_status, request_error) = match request {
            Ok(StatusCode::CONFLICT) => ("conflict", None),
            Ok(_) => ("accepted", None),
            Err(error) => ("failed", Some(format!("{error:#}"))),
        };
        let mut observation_error = None;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let snapshot = self.json(
                self.http
                    .get(format!("{}/tasks/{id}", self.base))
                    .timeout(self.request_timeout.min(remaining)),
            );
            match snapshot {
                Ok(snapshot) if task_id(&snapshot).ok() == Some(id) => task = snapshot,
                Ok(_) => {
                    observation_error =
                        Some("Intent Prover service response task ID is mismatched".into());
                    break;
                }
                Err(error) => {
                    observation_error = Some(format!("{error:#}"));
                    break;
                }
            }
            if !matches!(task["status"].as_str(), Some("queued" | "running"))
                || request_error.is_some()
            {
                break;
            }
            std::thread::sleep(
                Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
        let status = task["status"].as_str().unwrap_or("unknown").to_owned();
        let confirmation = match status.as_str() {
            "cancelled" => "terminal cancellation confirmed".to_owned(),
            "completed" | "failed" | "timed_out" | "data_expired" => {
                format!("task {status} during cancellation")
            }
            _ => format!(
                "cancellation not confirmed; last observed status: {status}; task may still be active"
            ),
        };
        let context = if reason == "interrupted" {
            "Interrupted"
        } else {
            "Cancellation requested"
        };
        let mut message =
            format!("{context}; task {id}; cancellation request {request_status}; {confirmation}");
        if let Some(error) = &request_error {
            message.push_str(&format!("; cancellation error: {error}"));
        }
        if let Some(error) = &observation_error {
            message.push_str(&format!("; status check failed: {error}"));
        }
        WaitResult {
            task,
            stop: Some(json!({"taskId": id, "reason": reason,
                "requestStatus": request_status, "requestError": request_error,
                "observationError": observation_error, "lastStatus": status,
                "cancellationConfirmed": status == "cancelled", "message": message})),
        }
    }

    pub fn tasks(&self, status: Option<&str>, before: Option<&str>, limit: u32) -> Result<Value> {
        let mut request = self
            .http
            .get(format!("{}/tasks", self.base))
            .query(&[("limit", limit)]);
        if let Some(status) = status {
            request = request.query(&[("status", status)]);
        }
        if let Some(before) = before {
            request = request.query(&[("before", before)]);
        }
        self.json(request)
    }

    pub fn task(&self, id: &str) -> Result<Value> {
        self.get(&format!("/tasks/{id}"))
    }

    pub fn cancel_task(&self, id: &str) -> Result<Value> {
        let task = self.task(id)?;
        if task_id(&task)? != id {
            bail!("Intent Prover service response task ID is mismatched");
        }
        let stopped = self.stop(id, task, "requested");
        Ok(json!({"task": stopped.task, "cancellation": stopped.stop}))
    }

    fn cancel(&self, id: &str, timeout: Duration) -> Result<StatusCode> {
        let response = self
            .http
            .post(format!("{}/tasks/{id}/cancel", self.base))
            .timeout(timeout)
            .send()?;
        let status = response.status();
        if status.is_success() || status == StatusCode::CONFLICT {
            return Ok(status);
        }
        let body = response.text()?;
        bail!(
            "Intent Prover service cancellation returned HTTP {status}: {}",
            error_detail(&body)
        )
    }

    fn log(&self, id: &str, stream: &str) -> Result<Vec<u8>> {
        Ok(self
            .file(id, stream)?
            .bytes()
            .map_err(|error| error.without_url())?
            .to_vec())
    }

    fn add_metrics(&self, id: &str, snapshot: &mut Value) {
        match self.file(id, "metrics").and_then(|response| {
            response
                .json::<Value>()
                .map_err(|error| error.without_url().into())
        }) {
            Ok(metrics) => {
                snapshot["metrics"] = metrics;
                snapshot.as_object_mut().unwrap().remove("metricsError");
            }
            Err(error) => snapshot["metricsError"] = json!(error.to_string()),
        }
    }

    fn file(&self, id: &str, name: &str) -> Result<Response> {
        let response = self
            .http
            .get(format!("{}/tasks/{id}/{name}", self.base))
            .send()?;
        let response = if response.status() == StatusCode::FOUND {
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| anyhow!("Intent Prover service file link has no Location header"))?
                .to_str()?;
            let url = response.url().join(location)?;
            if !url.username().is_empty() || url.password().is_some() {
                bail!("Intent Prover service file link contains unexpected credentials");
            }
            // Signed links carry their own authorization, even on the same host.
            self.files
                .get(url)
                .send()
                .map_err(|error| error.without_url())?
        } else {
            response
        };
        let status = response.status();
        if !status.is_success() {
            bail!("Intent Prover service {name} download returned HTTP {status}");
        }
        Ok(response)
    }

    fn get(&self, path: &str) -> Result<Value> {
        let request = self.http.get(format!("{}{}", self.base, path));
        self.json(request)
    }

    fn json(&self, request: RequestBuilder) -> Result<Value> {
        let response = request.send()?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            bail!(
                "Intent Prover service requires a valid API key; run intent-prover login and give the user its browser link and code"
            );
        }
        let status_error = response.error_for_status_ref().err();
        let body = response.text()?;
        if let Some(error) = status_error {
            return Err(anyhow::Error::new(error).context(format!(
                "Intent Prover service returned HTTP {status}: {}",
                error_detail(&body)
            )));
        }
        if !status.is_success() {
            bail!(
                "Intent Prover service returned HTTP {status}: {}",
                error_detail(&body)
            );
        }
        Ok(serde_json::from_str(&body)?)
    }
}

fn retryable_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
        error.is_timeout()
            || error.is_connect()
            || error.is_request()
            || error.is_body()
            || matches!(
                error.status().map(|status| status.as_u16()),
                Some(408 | 429 | 500 | 502 | 503 | 504)
            )
    })
}

pub fn record_submission(accepted: &Value, evidence: &Path) -> Result<()> {
    fs::create_dir_all(evidence)?;
    write_json(evidence, "result.json", &json!({"task": accepted}))
}

pub fn record_request(upload: &Upload, session: &Session, operation: &str) -> Result<PathBuf> {
    let root = &session.project_root;
    let _lock = crate::storage::lock(root)?;
    let intent = crate::storage::intent(root, true)?;
    let id = crate::storage::new_id(root)?;
    let evidence = intent.join("logs").join(&id);
    crate::storage::safe_parent(root, &evidence)?;
    fs::create_dir_all(&evidence)?;
    let specification = crate::storage::specification(
        root,
        &upload.requirements,
        upload.specification_id.as_deref(),
    )?;
    let inputs = evidence.join("inputs");
    crate::storage::safe_parent(root, &inputs)?;
    let mut manifest = Vec::new();
    for (name, bytes) in &upload.inputs {
        let file = inputs.join(name);
        crate::storage::safe_parent(root, &file)?;
        fs::create_dir_all(file.parent().unwrap())?;
        fs::write(&file, bytes)?;
        manifest.push(json!({"path":file.strip_prefix(&intent)?.to_string_lossy().replace('\\', "/"),"sha256":crate::storage::hash(bytes)}));
    }
    let mut controls = serde_json::Map::new();
    for (key, value) in &upload.fields {
        controls
            .entry(key.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(json!(value));
    }
    write_json(
        &evidence,
        "request.json",
        &json!({
            "version":1,"operation":operation,"session_id":session.session_id,"semantics":session.semantics,
            "api_url":crate::config::load()?.server_url,
            "submitted_at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis(),
            "inputs":manifest,"specification":specification,
            "properties":crate::storage::property_snapshot(root, &upload.requirements, &upload.inputs, &specification)?,
            "upload_sha256":crate::storage::hash(&upload.file.bytes),"controls":controls,
            "targets":upload.targets,"requirements":upload.requirements,
            "requirement_binding":{"version":1,"kind":"declared_association_not_uploaded","brief":null,"records":upload.requirements,"excluded":[]}
        }),
    )?;
    Ok(evidence)
}

pub fn write_json(directory: &Path, name: &str, value: &Value) -> Result<()> {
    let temporary = directory.join(format!(".{name}-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    fs::rename(temporary, directory.join(name))?;
    Ok(())
}

pub fn task_id(value: &Value) -> Result<&str> {
    value["id"]
        .as_str()
        .ok_or_else(|| anyhow!("Intent Prover service response has no task ID"))
}

fn error_detail(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return body.chars().take(65_536).collect();
    };
    let summary = match (value["code"].as_str(), value["message"].as_str()) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (_, Some(message)) => message.into(),
        _ => body.chars().take(65_536).collect(),
    };
    match value.get("details") {
        Some(details) => format!("{summary}; details: {details}"),
        None => summary,
    }
}
