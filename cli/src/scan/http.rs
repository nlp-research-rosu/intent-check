use super::support::{hash, re, string, valid_id};
use crate::{channel, config::Config};
use anyhow::Result;
use reqwest::{Url, blocking::Client, redirect::Policy};
use serde_json::{Value, json};
use std::{
    io::Read,
    time::{Duration, Instant},
};

const MAX_BODY: u64 = 8 * 1024 * 1024;
pub(super) struct Api {
    pub config: Config,
    http: Client,
    key: String,
}
pub(super) struct Reply {
    pub status: u16,
    pub body: Value,
    pub bytes: Vec<u8>,
    pub retry_after: Option<f64>,
    code: Option<&'static str>,
}
impl Reply {
    fn failure(code: &'static str) -> Self {
        Self {
            status: 0,
            body: Value::Null,
            bytes: Vec::new(),
            retry_after: None,
            code: Some(code),
        }
    }
    pub fn error(status: u16, code: &'static str) -> Self {
        Self {
            status,
            ..Self::failure(code)
        }
    }
    pub fn code(&self) -> String {
        self.code
            .map(str::to_owned)
            .or_else(|| {
                self.body["code"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("http_{}", self.status))
    }
    pub fn retryable(&self) -> bool {
        (self.status == 0 && self.code() != "bad_response")
            || [408, 429, 500, 502, 503, 504].contains(&self.status)
    }
}
impl Api {
    pub fn new(config: Config, key: String) -> Result<Self> {
        Ok(Self {
            config,
            key,
            http: Client::builder().redirect(Policy::none()).build()?,
        })
    }
    pub fn url(&self, id: &str) -> String {
        format!("{}/tasks/{id}", self.config.portal_url)
    }
    pub fn not_approved(&self) -> String {
        format!(
            "This account is not approved for Prover yet. Apply at {}/apply, then try again.",
            self.config.portal_url
        )
    }
    pub fn request(
        &self,
        path: &str,
        body: Option<&[u8]>,
        idem: Option<&str>,
        timeout: u64,
        redirect: bool,
    ) -> Reply {
        let started = Instant::now();
        let url = format!("{}{path}", self.config.server_url);
        let mut request = if body.is_some() {
            self.http.post(&url)
        } else {
            self.http.get(&url)
        };
        request = request
            .timeout(Duration::from_millis(timeout))
            .header("accept", "application/json")
            .header("X-Intent-Version", env!("CARGO_PKG_VERSION"))
            .header(
                "user-agent",
                concat!("intent-plugin/", env!("CARGO_PKG_VERSION")),
            )
            .bearer_auth(&self.key);
        if let Ok(pipe) = std::env::var("INTENT_PIPELINE")
            && ["llm", "canned"].contains(&pipe.as_str())
        {
            request = request.header("X-Intent-Pipeline", pipe);
        }
        if let Some(idem) = idem {
            request = request.header("Idempotency-Key", idem);
        }
        if let Some(bytes) = body {
            request = request
                .header("content-type", "application/gzip")
                .body(bytes.to_vec());
        }
        let response = request.send();
        let mut response = match response {
            Ok(r) => r,
            Err(e) => return Reply::failure(if e.is_timeout() { "timeout" } else { "network" }),
        };
        if redirect
            && [301, 302, 303, 307, 308].contains(&response.status().as_u16())
            && let Some(location) = response.headers().get("location")
        {
            let target = Url::parse(&url)
                .ok()
                .and_then(|u| location.to_str().ok().and_then(|s| u.join(s).ok()));
            let Some(target) = target.filter(|u| {
                u.scheme() == "https" || (u.scheme() == "http" && url.starts_with("http:"))
            }) else {
                return Reply::failure("bad_redirect");
            };
            // Even same-origin signed URLs receive no API or plugin headers.
            let remaining = Duration::from_millis(timeout).saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Reply::failure("timeout");
            }
            response = match self
                .http
                .get(target)
                .header("accept", "application/json")
                .timeout(remaining)
                .send()
            {
                Ok(r) => r,
                Err(e) => {
                    return Reply::failure(if e.is_timeout() { "timeout" } else { "network" });
                }
            };
        }
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.);
        let mut bytes = Vec::new();
        if response.take(MAX_BODY + 1).read_to_end(&mut bytes).is_err() {
            return Reply::failure("network");
        }
        if bytes.len() as u64 > MAX_BODY {
            return Reply::failure("too_large");
        }
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply {
            status,
            body,
            bytes,
            retry_after,
            code: None,
        }
    }
    pub fn submit(&self, gz: &[u8], idem: &str) -> Reply {
        let timeout = (60000 + 20000 * gz.len().div_ceil(1024 * 1024) as u64).min(300000);
        self.request("/scan", Some(gz), Some(idem), timeout, false)
    }
    pub fn task(&self, id: &str) -> Reply {
        let reply = self.request(&format!("/tasks/{id}"), None, None, 10000, false);
        if reply.status == 200
            && (reply.body["id"] != id
                || reply.body["kind"] != "scan"
                || !reply.body["status"].is_string())
        {
            return Reply::failure("bad_response");
        }
        reply
    }
    pub fn report(&self, task: &Value) -> Reply {
        if task["status"] == "data_expired" {
            return Reply::error(410, "TASK_FILES_EXPIRED");
        }
        let id = string(&task["id"]);
        let reference = &task["result"]["report"];
        let path = format!("/tasks/{id}/artifacts/report.json");
        if !valid_id(id)
            || reference["name"] != "report.json"
            || reference["url"] != path
            || reference["size"].as_u64().is_none_or(|n| n > MAX_BODY)
            || !re(r"^[0-9a-f]{64}$").is_match(string(&reference["sha256"]))
        {
            return Reply::error(400, "INVALID_REPORT_REFERENCE");
        }
        let reply = self.request(&path, None, None, 10000, true);
        if reply.status != 200 {
            return reply;
        }
        if Some(reply.bytes.len() as u64) != reference["size"].as_u64()
            || hash(&reply.bytes) != reference["sha256"]
        {
            return Reply::failure("REPORT_HASH_MISMATCH");
        }
        if reply.body["version"].as_i64().is_none()
            || !reply.body["cards"].is_array()
            || !reply.body["one_liners"].is_array()
            || reply.body["coverage"].is_null()
            || reply.body["coverage"] == false
            || reply.body["coverage"].as_f64() == Some(0.)
            || reply.body["coverage"].as_str() == Some("")
        {
            return Reply::error(400, "INVALID_REPORT");
        }
        reply
    }
}

pub(super) fn progress(task: &Value) -> Value {
    let stage = string(&task["status"]);
    let result = &task["result"];
    let status = if ["queued", "running"].contains(&stage) {
        stage
    } else if task["error"]["code"] == "SUPERSEDED" && result.is_null() {
        "superseded"
    } else if ["completed", "data_expired"].contains(&stage) && !result.is_null() {
        "done"
    } else {
        "failed"
    };
    let mut progress = json!({"status":status,"stage":stage});
    if !result.is_null() {
        progress["budget_s"] = result["budgetSeconds"].clone();
        if status == "done" {
            let cards = result["cards"]
                .as_array()
                .map(|cards| {
                    cards
                        .iter()
                        .map(|c| {
                            let mut c = c.clone();
                            if let Some(object) = c.as_object_mut() {
                                let repro = object.remove("reproSketch").unwrap_or(Value::Null);
                                object.insert("repro_sketch".into(), repro);
                            }
                            c
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            progress["summary"] = json!({"counts":result["counts"],"cards":cards,"one_liners":result.get("oneLiners").unwrap_or(&json!([]))});
        }
    }
    if status == "failed" {
        progress["error"] = json!({"code":task["error"]["code"].as_str().unwrap_or(stage),"message":task["error"]["message"].as_str().unwrap_or("")});
    }
    progress
}

pub(super) fn submit_failure(api: &Api, r: &Reply) -> String {
    let cli = channel::settings().cli;
    let code = r.code();
    match r.status {
        404 => "Scan is not enabled on this service yet.".into(),
        413 => "The upload is too large. Scan fewer files or one smaller folder.".into(),
        429 => match (string(&r.body["details"]["reason"]), code.as_str()) {
            ("scan_ingest_busy", _) => {
                "Scan is busy receiving other uploads, try again in a moment.".into()
            }
            (_, "SPEND_CAP") => "The daily spending limit was reached. Try again tomorrow.".into(),
            (_, "BLOCKED") => "Scan is not available for this account.".into(),
            (_, "TOO_MANY_FAILED_AUTHENTICATIONS") => {
                format!("The service is turning away this machine's sign-in. Run {cli} login.")
            }
            ("scan_account_daily", _) => {
                "The daily Scan limit for your account is reached. It resets at 00:00 UTC.".into()
            }
            _ => "Too many scans in a short time. Try again later.".into(),
        },
        400 => super::support::clip(
            &format!(
                "The service did not accept the upload: {}",
                r.body["message"].as_str().unwrap_or(&code)
            )
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
            300,
        ),
        401 => format!("The service did not accept the API key. Run {cli} login to connect again."),
        _ if code == "ACCESS_NOT_APPROVED" => api.not_approved(),
        426 => format!(
            "This plugin version is too old for the service. Update the {} plugin.",
            channel::settings().plugin
        ),
        0 => "Couldn't reach the service. Try again in a moment.".into(),
        _ => format!(
            "The service answered {} ({code}). Try again in a moment.",
            r.status
        ),
    }
}
