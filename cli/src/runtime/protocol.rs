use super::*;
use reqwest::{
    blocking::{Client, Response},
    header::{AUTHORIZATION, HeaderMap, HeaderValue, LOCATION},
    redirect::Policy,
};

pub(super) const ART: &[&str] = &[
    "INTENT.md",
    "SPEC.k",
    "SEMANTICS.k",
    "VERDICT.md",
    "VERIFICATION.k",
    "REASONING.md",
];
pub(super) struct Api {
    http: Client,
    files: Client,
    base: String,
    portal: String,
    used_key: String,
}
pub(super) struct Reply {
    pub status: u16,
    pub body: Value,
    pub retry_after: Option<u64>,
}
impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn code(&self) -> &str {
        self.body["code"]
            .as_str()
            .unwrap_or(if self.status == 0 { "network" } else { "http" })
    }
}
impl Api {
    pub fn new(rt: &Runtime) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert("X-Intent-Version", HeaderValue::from_str(&rt.version)?);
        headers.insert(
            "user-agent",
            HeaderValue::from_str(&format!("intent-plugin/{}", rt.version))?,
        );
        let used_key = rt.key()?.unwrap_or_default();
        if !used_key.is_empty() {
            let key = &used_key;
            let mut auth = HeaderValue::from_str(&format!("Bearer {key}"))?;
            auth.set_sensitive(true);
            headers.insert(AUTHORIZATION, auth);
        }
        if let Ok(p) = env::var("INTENT_PIPELINE")
            && ["llm", "canned"].contains(&p.as_str())
        {
            headers.insert("X-Intent-Pipeline", HeaderValue::from_str(&p)?);
        }
        Ok(Self {
            http: Client::builder()
                .default_headers(headers)
                .redirect(Policy::none())
                .build()?,
            files: Client::builder().redirect(Policy::limited(5)).build()?,
            base: rt.config.server_url.clone(),
            portal: rt.config.portal_url.clone(),
            used_key,
        })
    }
    pub fn report(&self, id: &str) -> String {
        format!("{}/tasks/{id}", self.portal)
    }
    pub fn used_key(&self) -> &str {
        &self.used_key
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Vec<u8>>,
        idem: Option<&str>,
        timeout: u64,
    ) -> Reply {
        let result = (|| -> Result<Reply> {
            let mut request = self
                .http
                .request(
                    reqwest::Method::from_bytes(method.as_bytes())?,
                    format!("{}{path}", self.base),
                )
                .timeout(Duration::from_millis(timeout));
            if let Some(body) = body {
                request = request
                    .header(
                        "Content-Type",
                        if path == "/deepscans" {
                            "application/gzip"
                        } else {
                            "application/json"
                        },
                    )
                    .body(body);
            }
            if let Some(idem) = idem {
                request = request.header("Idempotency-Key", idem);
            }
            let response = request.send()?;
            let status = response.status().as_u16();
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse().ok());
            let mut bytes = Vec::new();
            response
                .take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            anyhow::ensure!(bytes.len() <= 16 * 1024 * 1024, "Response exceeds limit");
            let body = serde_json::from_slice(&bytes).unwrap_or(json!({}));
            Ok(Reply {
                status,
                body,
                retry_after,
            })
        })();
        result.unwrap_or_else(|error| Reply{status:0,body:json!({"code":if error.downcast_ref::<reqwest::Error>().is_some_and(|e|e.is_timeout()){"timeout"}else{"network"}}),retry_after:None})
    }
    pub fn task(&self, id: &str, timeout: u64) -> Reply {
        self.request("GET", &format!("/tasks/{id}"), None, None, timeout)
    }
    pub fn submit(&self, built: &payload::Built, idem: &str, timeout: u64) -> Reply {
        self.request(
            "POST",
            "/intent-checks",
            Some(built.request.to_string().into_bytes()),
            Some(idem),
            timeout,
        )
    }
    pub fn artifact(&self, task: &str, reference: &Value, max: u64) -> Result<Vec<u8>> {
        let url = string(&reference["url"]);
        anyhow::ensure!(
            valid_id(task)
                && url.starts_with(&format!("/tasks/{task}/artifacts/"))
                && re(r"^/tasks/[0-9a-f-]{36}/artifacts/(?:report\.json|[0-9]{1,3}/[A-Za-z.]+)$")
                    .is_match(url)
                && !url.contains(".."),
            "Invalid artifact reference"
        );
        let size = reference["size"]
            .as_u64()
            .context("Missing artifact size")?;
        anyhow::ensure!(size <= max, "Artifact exceeds limit");
        let digest = string(&reference["sha256"]);
        anyhow::ensure!(
            re(r"^[0-9a-f]{64}$").is_match(digest),
            "Invalid artifact hash"
        );
        let mut response = self
            .http
            .get(format!("{}{url}", self.base))
            .timeout(Duration::from_secs(10))
            .send()?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .context("Missing artifact redirect")?
                .to_str()?;
            let url = response.url().join(location)?;
            anyhow::ensure!(
                url.username().is_empty()
                    && url.password().is_none()
                    && (url.scheme() == "https"
                        || (url.scheme() == "http" && self.base.starts_with("http://"))),
                "Invalid artifact URL"
            );
            response = self
                .files
                .get(url)
                .timeout(Duration::from_secs(10))
                .send()?;
        }
        let response: Response = response.error_for_status()?;
        let mut bytes = Vec::new();
        response.take(max + 1).read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() as u64 == size && hash(&bytes) == digest,
            "Artifact size or hash mismatch"
        );
        Ok(bytes)
    }
    pub fn check(&self, id: &str, timeout: u64) -> Reply {
        let mut r = self.task(id, timeout);
        if !r.ok() {
            if r.status == 400 {
                r.status = 404;
            }
            return r;
        }
        if r.body["kind"] != "intentCheck" || r.body["id"] != id {
            return Reply {
                status: 0,
                body: json!({"code":"bad_response"}),
                retry_after: None,
            };
        }
        let status = status(&r.body);
        let t = &r.body;
        let mut result = Value::Null;
        if status == "done" {
            let convert = (|| -> Result<Value> {
                let mut units = Vec::new();
                for u in array(&t["result"]["units"]) {
                    let mut artifacts = json!({});
                    if t["status"] == "completed" {
                        for name in ART {
                            if !u["artifacts"][name].is_null() {
                                let bytes =
                                    self.artifact(id, &u["artifacts"][name], 16 * 1024 * 1024)?;
                                artifacts[name] = json!(String::from_utf8(bytes)?);
                            }
                        }
                    }
                    units.push(json!({"path":u["path"],"checked_sha256":u["checkedSha256"],"partial":u["partial"]==true,"verdict":snake(string(&u["verdict"])),"claims":array(&u["claims"]).iter().map(|c|json!({"id":c["id"],"function":c["function"],"status":snake(string(&c["status"]))})).collect::<Vec<_>>(),"artifacts":artifacts}));
                }
                Ok(
                    json!({"verdict":snake(string(&t["result"]["verdict"])),"partial":t["result"]["partial"]==true,"checked_at":t["finishedAt"],"agent_concerns":array(&t["result"]["concerns"]).iter().map(|c|json!({"id":c["id"],"type":snake(string(&c["type"])),"severity":c["severity"],"path":c["path"],"line":c["line"],"claim_id":c["claimId"],"title":c["title"],"explanation":c["explanation"],"fix_direction":c["fixDirection"]})).collect::<Vec<_>>(),"units":units}),
                )
            })();
            match convert {
                Ok(value) => result = value,
                Err(_) => {
                    return Reply {
                        status: 0,
                        body: json!({"code":"artifact_fetch"}),
                        retry_after: None,
                    };
                }
            }
        }
        r.body = json!({"status":status,"url":self.report(id),"result":result,"error":t["error"]});
        r
    }
}
pub(super) fn valid_id(id: &str) -> bool {
    re(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").is_match(id)
}
pub(super) fn status(task: &Value) -> &'static str {
    if task["status"] == "queued" {
        "queued"
    } else if task["status"] == "running" {
        "running"
    } else if task["error"]["code"] == "SUPERSEDED" && task["result"].is_null() {
        "superseded"
    } else if (task["status"] == "completed" || task["status"] == "data_expired")
        && task["result"].is_object()
    {
        "done"
    } else {
        "failed"
    }
}
fn snake(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}
