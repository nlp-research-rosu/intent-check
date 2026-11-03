use super::*;
use protocol::{Api, Reply};
use std::sync::atomic::{AtomicBool, Ordering};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);
pub(super) fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::Relaxed)
}
const CONSENT: &str = "Intent Check is on. After a turn that changes source files, it sends your recent prompts, the diffs, the changed files and applicable .intent requirements to the Intent Check service for a background review; obvious secrets are masked first. Each upload is listed in .intent/.sent.log. To turn it off: /intent:off";

fn merge(out: &mut Output, mut other: Output) {
    out.add(&other.user, &other.context);
    out.acknowledgments.append(&mut other.acknowledgments);
}
pub(super) fn hook(rt: &Runtime, event: &str, payload: &Value) -> Result<Output> {
    if env::var("INTENT_DEBUG").as_deref() == Ok("1") {
        rt.log("hook.in", json!({"hook":match event {"session-start"=>"SessionStart","prompt"=>"UserPromptSubmit","post-tool"=>"PostToolUse",_=>"Stop"},"host":rt.host}));
    }
    let key = state::key(payload);
    if rt.disabled().is_some() {
        if event == "stop" {
            rt.session_mut(&key, |s| {
                s["touched"] = json!([]);
                s["patches"] = json!({});
                Ok(())
            })?;
            scan::discard_queue(&capture::root(&cwd(payload)?))?;
        }
        return Ok(Output::default());
    }
    state::private_dir(&rt.data)?;
    if matches!(event, "session-start" | "stop")
        && rt.config.lsp.values().any(|server| !server.disabled)
    {
        let result = cwd(payload)
            .and_then(|cwd| crate::session::project_root(&cwd))
            .and_then(|root| rt.spawn("lsp", &root.to_string_lossy()));
        if let Err(error) = result {
            rt.log("lsp.failed", json!({"message":format!("{error:#}")}));
        }
    }
    match event {
        "session-start" | "prompt" => {
            let mut out = Output::default();
            if event == "session-start" {
                state::gc(rt)?;
            }
            rt.global_mut(|g| {
                if g["consent_shown_at"].is_null(){g["consent_shown_at"]=json!(iso(now()));let consent=if rt.host=="codex"{CONSENT.replace("To turn it off: /intent:off","To turn it off: ask the agent to turn Intent Check off, or set INTENT_DISABLED=1")}else{CONSENT.into()};out.add(&consent,"The Intent Check plugin is active: code changes are reviewed in the background, and concerns may arrive later as notes. The user can turn it off with intent-check off.");}
                if g["ready_version"]!=rt.version{g["ready_version"]=json!(rt.version);out.add(&format!("Intent Check v{} ready",rt.version),"");}
                if rt.host=="codex" && g["hook_notice_version"]!=rt.version {g["hook_notice_version"]=json!(rt.version);out.add(&format!("Intent Check {} updated its edit hook. If Codex lists it as Modified, approve it in /hooks (or the app's hook review).",rt.version),"");}
                Ok(())
            })?;
            if event == "prompt" {
                let typed = strip_injected(string(&payload["prompt"]));
                rt.session_mut(&key, |s| {
                    if !typed.starts_with("<task-notification>")
                        && !typed.trim().is_empty()
                        && !typed.trim().starts_with("/intent:")
                    {
                        let turn = payload["prompt_id"]
                            .as_str()
                            .or_else(|| payload["turn_id"].as_str());
                        state::push(&mut s["prompts"], json!(clip(&typed, 16000)), 4);
                        state::push(&mut s["prompt_ids"], json!(turn), 4);
                        if s["first_prompt"].is_null()
                            && typed.trim().len() >= 20
                            && !typed.trim().starts_with('/')
                        {
                            s["first_prompt"] = json!(clip(&typed, 16000));
                            s["first_prompt_id"] = json!(turn);
                        }
                        s["prompt_count"] = json!(number(&s["prompt_count"]) + 1);
                        s["turn_id"] = json!(
                            turn.map(str::to_owned)
                                .unwrap_or_else(|| format!("turn-{}", number(&s["prompt_count"])))
                        );
                    }
                    if payload["permission_mode"].is_string() {
                        s["permission_mode"] = payload["permission_mode"].clone();
                    }
                    Ok(())
                })?;
                let previous = rt.session(&key);
                if array(&previous["touched"]).is_empty()
                    || (previous["baseline"]["sha"].is_null()
                        && previous["baseline"]["shadow"].is_null())
                {
                    let base = capture::baseline(rt, &cwd(payload)?);
                    rt.session_mut(&key, |s| {
                        if array(&s["touched"]).is_empty() || s["baseline"].is_null() {
                            s["baseline"] = base;
                        }
                        Ok(())
                    })?;
                }
            }
            connection(
                rt,
                &key,
                &mut out,
                if event == "session-start" { 1000 } else { 0 },
            )?;
            late(rt, &key)?;
            merge(&mut out, state::lease_notes(rt, &key, None)?);
            scan::deliver(rt, &capture::root(&cwd(payload)?), &mut out)?;
            Ok(out)
        }
        "post-tool" => post_tool(rt, payload, &key),
        "stop" => {
            if rt.host == "claude-code"
                && ["sdk-cli", "sdk-ts", "sdk-py", "local-agent", "mcp"].contains(
                    &env::var("CLAUDE_CODE_ENTRYPOINT")
                        .unwrap_or_default()
                        .as_str(),
                )
            {
                rt.handoff("stop", payload)?;
                return Ok(Output::default());
            }
            stop(
                rt,
                payload,
                rt.host == "claude-code" && payload["stop_hook_active"] != true,
                rt.host != "codex",
            )
        }
        _ => bail!("Unknown hook event"),
    }
}
fn strip_injected(input: &str) -> String {
    let mut text = input.trim_start();
    loop {
        let Some(tag) = [
            "browser_instruction",
            "system-reminder",
            "local-command-stdout",
            "local-command-caveat",
        ]
        .into_iter()
        .find(|tag| text.starts_with(&format!("<{tag}>"))) else {
            return text.into();
        };
        let closing = format!("</{tag}>");
        let Some(end) = text.find(&closing) else {
            return String::new();
        };
        text = text[end + closing.len()..].trim_start();
    }
}
fn connection(rt: &Runtime, key: &str, out: &mut Output, wait: u64) -> Result<()> {
    let dir = crate::config::directory()?;
    let identity = hash(format!(
        "{}\n{}",
        reqwest::Url::parse(&rt.config.server_url)?
            .origin()
            .ascii_serialization(),
        reqwest::Url::parse(&rt.config.portal_url)?
            .origin()
            .ascii_serialization()
    ));
    let file = dir.join(format!("login-{}.json", &identity[..32]));
    let output = dir.join(format!("login-{}.out", &identity[..32]));
    if rt.key()?.is_some() {
        if file.exists() {
            let announce = state::update(&file, json!({}), |s| {
                let announce = s["announced"] != true;
                s["announced"] = json!(true);
                Ok(announce)
            })?;
            if announce {
                out.add(
                    "Intent Check connected",
                    "Intent Check connected. Continue with the user's task.",
                );
            }
        }
        return Ok(());
    }
    state::update(&file, json!({}), |s| {
        let lines = login_lines(&output);
        if lines.last().is_some_and(|v| v["status"] == "denied") {
            return Ok(());
        }
        if state::alive(number(&s["pid"])) || now().saturating_sub(number(&s["created_at"])) < 30000
        {
            return Ok(());
        }
        let mut command = Command::new(env::current_exe()?);
        let log = state::append(&output, true)?;
        log.set_len(0)?;
        command
            .arg("login")
            .env("INTENT_API_URL", &rt.config.server_url)
            .env("INTENT_CONSOLE_URL", &rt.config.portal_url)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000008 | 0x00000200 | 0x08000000);
        }
        let child = command.spawn()?;
        *s = json!({"created_at":now(),"pid":child.id()});
        Ok(())
    })?;
    let deadline = Instant::now() + Duration::from_millis(wait);
    let mut pending = None;
    loop {
        if let Some(bytes) = fs::read(&output).ok().filter(|bytes| bytes.len() <= 16384) {
            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line)
                    && value["status"] == "pending"
                    && re(r"^[A-Z]{4}-[A-Z]{4}$").is_match(string(&value["user_code"]))
                    && string(&value["verification_url"])
                        .starts_with(&format!("{}/connect/", rt.config.portal_url))
                {
                    pending = Some(value);
                    break;
                }
            }
        }
        if pending.is_some() || Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let state = state::read(&file);
    let lines = login_lines(&output);
    let last = lines.last();
    let terminal = last
        .and_then(|v| v["status"].as_str())
        .filter(|s| ["denied", "expired", "consumed", "failed", "failure"].contains(s));
    let active = state::alive(number(&state["pid"]));
    let valid_pending = pending.as_ref().filter(|v| {
        active
            && number(&v["expires_in"]) >= 1
            && number(&v["expires_in"]) <= 900
            && now().saturating_sub(number(&state["created_at"])) < number(&v["expires_in"]) * 1000
            && terminal.is_none()
    });
    let status = terminal.unwrap_or(if valid_pending.is_some() {
        "pending"
    } else if active {
        "starting"
    } else {
        "failed"
    });
    let text=valid_pending.map(|v|format!("Intent Check: connect your account → {}\nOpen the link and approve; your task can continue while sign-in finishes.",string(&v["verification_url"]))).unwrap_or_else(||match status {
        "starting"=>"Intent Check is starting sign-in through the global CLI. The approval link will appear on your next prompt; your task can continue.",
        "denied"=>"Intent Check sign-in was denied. Nothing is checked; run intent-check login when you want to reconnect.",
        _=>"Intent Check could not finish sign-in. Run intent-check login to retry; nothing is being checked yet."
    }.into());
    let token = format!("{}:{status}", number(&state["created_at"]));
    rt.session_mut(key, |s| {
        if s["flags"]["login_shown"] != token {
            s["flags"]["login_shown"] = json!(token);
            out.add(&text, &text);
        }
        Ok(())
    })?;
    Ok(())
}
fn login_lines(file: &Path) -> Vec<Value> {
    fs::read(file)
        .ok()
        .filter(|b| b.len() <= 16384)
        .map(|b| {
            String::from_utf8_lossy(&b)
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        })
        .unwrap_or_default()
}
fn tool_paths(payload: &Value, root: &Path) -> Vec<PathBuf> {
    let input = &payload["tool_input"];
    let mut paths = Vec::new();
    if payload["tool_name"] == "apply_patch" {
        let mut old = None;
        for line in string(&input["command"]).lines() {
            if let Some(path) = line.strip_prefix("*** Move to: ") {
                if let Some(old) = old.take() {
                    paths.retain(|p| *p != old);
                }
                paths.push(root.join(path.trim()));
            } else if let Some(path) = line
                .strip_prefix("*** Add File: ")
                .or_else(|| line.strip_prefix("*** Update File: "))
            {
                let path = root.join(path.trim());
                old = Some(path.clone());
                paths.push(path);
            } else {
                old = None;
            }
        }
    } else if let Some(path) = if payload["tool_name"] == "NotebookEdit" {
        input["notebook_path"].as_str()
    } else {
        input["file_path"].as_str()
    } {
        paths.push(root.join(path));
    }
    paths.sort();
    paths.dedup();
    paths
}
fn post_tool(rt: &Runtime, payload: &Value, key: &str) -> Result<Output> {
    let cwd = cwd(payload)?;
    let tool = string(&payload["tool_name"]);
    let paths = tool_paths(payload, &cwd);
    rt.session_mut(key, |s| {
        if ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"].contains(&tool) {
            for path in &paths {
                state::unique(&mut s["touched"], json!(path), 200);
                if !s["flags"]["touched_at"].is_object() {
                    s["flags"]["touched_at"] = json!({});
                }
                s["flags"]["touched_at"][path.to_string_lossy().as_ref()] = json!(id());
                if s["baseline"]["sha"].is_null() {
                    let patches = &payload["tool_response"]["structuredPatch"];
                    let p = path.to_string_lossy();
                    let mut used = array(&s["patches"][p.as_ref()])
                        .iter()
                        .map(|h| array(&h["lines"]).len())
                        .sum::<usize>();
                    for patch in array(patches).iter().take(20) {
                        let n = array(&patch["lines"]).len();
                        if used + n > 400 {
                            break;
                        }
                        state::push(&mut s["patches"][p.as_ref()], patch.clone(), 400);
                        used += n;
                    }
                }
            }
        } else if tool == "ExitPlanMode" && payload["tool_input"]["plan"].is_string() {
            s["plan"] = json!(clip(string(&payload["tool_input"]["plan"]), 16000));
        } else if tool == "TodoWrite" {
            s["todos"] = json!(
                array(&payload["tool_input"]["todos"])
                    .iter()
                    .take(30)
                    .filter_map(|t| t["content"].as_str().or_else(|| t.as_str()))
                    .map(|s| clip(s, 200))
                    .collect::<Vec<_>>()
            );
        }
        Ok(())
    })?;
    if !rt.live() {
        return Ok(Output::default());
    }
    if let Some(api_key) = rt.key()?
        && rt.paused(&api_key).is_none()
    {
        if ["Bash", "PowerShell"].contains(&tool) {
            let go = rt.session_mut(key, |s| {
                if s["baseline"]["sha"].is_null() && s["baseline"]["shadow"].is_null() {
                    return Ok(false);
                }
                if now().saturating_sub(number(&s["flags"]["shell_scan"]["at"])) < 60000 {
                    s["flags"]["shell_scan"]["again"] = json!(true);
                    return Ok(false);
                }
                s["flags"]["shell_scan"] = json!({"at":now(),"again":false});
                Ok(true)
            })?;
            if go {
                rt.handoff("shell", payload)?;
            }
        } else {
            let session = rt.session(key);
            let root = session["baseline"]["repo"]
                .as_str()
                .or_else(|| session["baseline"]["shadow"]["root"].as_str())
                .map(PathBuf::from);
            for path in paths {
                if root.as_ref().is_some_and(|r| {
                    capture::relative(r, &path).is_none_or(|rel| filter::classify(&rel) == "no")
                }) {
                    continue;
                }
                let mut job = payload.clone();
                job["path"] = json!(path);
                if !spawn_edit(rt, &job)? {
                    break;
                }
            }
        }
    }
    state::lease_notes(rt, key, Some("concerns"))
}
fn spawn_edit(rt: &Runtime, payload: &Value) -> Result<bool> {
    let key = state::key(payload);
    let reserve = id();
    let go = rt.session_mut(&key, |s| {
        for name in ["edit_reserved", "edit_pending"] {
            if !s[name].is_object() {
                s[name] = json!({});
            }
            s[name]
                .as_object_mut()
                .expect("Reservation object")
                .retain(|_, v| {
                    now().saturating_sub(if name == "edit_reserved" {
                        number(v)
                    } else {
                        number(&v["at"])
                    }) < if name == "edit_reserved" {
                        30000
                    } else {
                        60000
                    }
                });
        }
        let count = s["edit_jobs"]
            .as_object()
            .map(|m| {
                m.values()
                    .filter(|v| {
                        v["settled"] != true
                            && now().saturating_sub(number(&v["submitted_at"])) < 1800000
                    })
                    .count()
            })
            .unwrap_or(0)
            + s["edit_reserved"].as_object().map(|m| m.len()).unwrap_or(0);
        if count >= 12 {
            return Ok(false);
        }
        s["edit_reserved"][&reserve] = json!(now());
        s["edit_pending"][&reserve] = json!({"abs":payload["path"],"at":now()});
        Ok(true)
    })?;
    if go {
        let mut job = payload.clone();
        job["reserve_id"] = json!(reserve);
        if let Err(e) = rt.handoff("edit", &job) {
            release_edit(rt, &key, &reserve)?;
            return Err(e);
        }
    }
    Ok(go)
}
fn release_edit(rt: &Runtime, key: &str, reserve: &str) -> Result<()> {
    rt.session_mut(key, |s| {
        state::remove(&mut s["edit_reserved"], reserve);
        state::remove(&mut s["edit_pending"], reserve);
        Ok(())
    })
}
fn covered(s: &Value, file: &capture::FileChange, pending: bool) -> bool {
    s["edit_jobs"].as_object().is_some_and(|m| {
        m.values().any(|e| {
            e["rel"] == file.rel
                && e["sha256"] == hash(&file.bytes)
                && (e["settled"] == true
                    || now().saturating_sub(number(&e["submitted_at"])) < 86400000)
        })
    }) || (pending
        && s["edit_pending"].as_object().is_some_and(|m| {
            m.values().any(|p| {
                p["abs"] == file.abs.to_string_lossy().as_ref()
                    && now().saturating_sub(number(&p["at"])) < 60000
            })
        }))
}
fn record(rt: &Runtime, ok: bool, message: &str) -> Result<()> {
    rt.global_mut(|g| {
        g["last_check"] = json!({"at":iso(now()),"ok":ok});
        if !ok {
            g["last_error"] = json!({"at":iso(now()),"text":clip(message,200)});
        }
        Ok(())
    })
}
fn failure(rt: &Runtime, key: &str, r: &Reply, used: &str) -> Result<()> {
    record(
        rt,
        false,
        &format!("service answered {} ({})", r.status, r.code()),
    )?;
    if [401, 426].contains(&r.status) {
        rt.global_mut(|g|{g["paused"]=json!({"id":&hash(format!("{used}\n{}",rt.version))[..16],"code":r.status,"source":if env::var("INTENT_API_KEY").is_ok(){"env"}else{"file"},"at":iso(now())});Ok(())})?;
        if r.status == 401
            && env::var("INTENT_API_KEY").is_err()
            && rt.key()?.as_deref() == Some(used)
        {
            crate::auth::clear_key(&rt.config.server_url, used)?;
        }
    }
    let text = match r.status {
        401 => {
            "Intent Check: the API key was not accepted, so checks are paused. Run intent-check login to reconnect."
        }
        426 => {
            "Intent Check: this plugin version is too old for the service. Update the intent plugin to keep checks running."
        }
        429 if r.code() == "SPEND_CAP" => {
            "Intent Check: today's free check limit was reached, so recent changes were not checked. Checks resume tomorrow."
        }
        429 => "Intent Check: too many checks in a short time, so recent changes were not checked.",
        0 => {
            "Intent Check: couldn't reach the service, so recent changes haven't been checked yet. They will be once it's back."
        }
        _ => {
            "Intent Check: the service could not start the review; it will retry when appropriate."
        }
    };
    rt.session_mut(key, |s| {
        state::note(
            s,
            text,
            true,
            "info",
            Some(&format!("failure:{}:{}", r.status, r.code())),
        );
        Ok(())
    })
}
pub(super) fn run_dir(root: &Path, id: &str) -> Result<PathBuf> {
    anyhow::ensure!(protocol::valid_id(id), "Invalid run ID");
    crate::storage::intent(root, true)?;
    let dir = root.join(".intent/runs").join(id);
    crate::storage::safe_parent(root, &dir)?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}
fn request_record(root: &Path, id: &str, built: &payload::Built) -> Result<()> {
    let request = &built.request;
    let dir = run_dir(root, id)?;
    state::write(
        &dir.join("request.json"),
        &json!({"version":1,"operation":"check","trigger":if request["mode"]=="request"{"request"}else if request["per_edit"]==true{"edit"}else{"turn"},"submitted_at":now(),"host":request["host"],"session_id":request["session_id"],"partial":request["truncated"],"submitted_context_sha256":request["intent"]["notes"].as_str().map(hash),"requirement_binding":built.binding,"sources":array(&request["units"]).iter().map(|u|json!({"path":u["path"],"source_sha256":u["sha256"],"submitted_sha256":hash(string(&u["content"])),"content_truncated":u["content_truncated"],"regions":u["regions"]})).collect::<Vec<_>>()}),
        false,
    )
}
pub(super) fn audit(root: &Path, entry: Value) {
    let _ = (|| -> Result<()> {
        crate::storage::intent(root, true)?;
        let path = root.join(".intent/.sent.log");
        crate::storage::safe_parent(root, &path)?;
        writeln!(state::append(&path, false)?, "{entry}")?;
        Ok(())
    })();
}
struct Submission<'a> {
    key: &'a str,
    root: &'a Path,
    built: &'a payload::Built,
    idem: &'a str,
    payload: &'a Value,
    edit: bool,
    wake: bool,
    timeout: u64,
}
fn submit(rt: &Runtime, api: &Api, submission: Submission<'_>) -> Result<Reply> {
    let Submission {
        key,
        root,
        built,
        idem,
        payload,
        edit,
        wake,
        timeout,
    } = submission;
    let reply = api.submit(built, idem, timeout);
    audit(
        root,
        json!({"time":iso(now()),"url":format!("{}/intent-checks",rt.config.server_url),"mode":built.request["mode"],"status":if reply.status==202{"sent"}else{"failed"},"job_id":reply.body["id"],"paths":array(&built.sent).iter().map(|s|s["rel"].clone()).collect::<Vec<_>>(),"bytes":built.request.to_string().len(),"redactions":built.redactions}),
    );
    if reply.status != 202 || !protocol::valid_id(string(&reply.body["id"])) {
        failure(rt, key, &reply, api.used_key())?;
        return Ok(reply);
    }
    let id = string(&reply.body["id"]);
    rt.log(
        "job.submitted",
        json!({"job":id,"mode":built.request["mode"],"units":array(&built.sent).len()}),
    );
    if let Err(error) = request_record(root, id, built) {
        rt.log("intentdir.write_failed", json!({"error":error.to_string()}));
    }
    let mut job = json!({"job_id":id,"url":api.report(id),"repo":root,"mode":built.request["mode"],"sent":built.sent,"permission_mode":payload::permission(rt,payload),"host":rt.host,"turn_id":built.request["turn_id"],"submitted_at":now(),"wake":wake,"edit":edit});
    rt.session_mut(key, |s| {
        if edit {
            job["rel"] = built.sent[0]["rel"].clone();
            job["sha256"] = built.sent[0]["sha256"].clone();
            s["edit_jobs"][id] = job.clone();
            let mut settled: Vec<_> = s["edit_jobs"]
                .as_object()
                .expect("Edit jobs object")
                .iter()
                .filter(|(_, v)| v["settled"] == true)
                .map(|(id, v)| (id.clone(), number(&v["submitted_at"])))
                .collect();
            settled.sort_by_key(|(_, at)| *at);
            let excess = s["edit_jobs"]
                .as_object()
                .expect("Edit jobs object")
                .len()
                .saturating_sub(100);
            for (id, _) in settled.into_iter().take(excess) {
                state::remove(&mut s["edit_jobs"], &id);
            }
        } else if !array(&s["pending"]).iter().any(|p| p["job_id"] == id) {
            state::push(&mut s["pending"], job.clone(), 100);
        }
        // A new edit of the same path must survive a concurrent submission.
        if !edit {
            let keep: Vec<_> = array(&s["touched"])
                .iter()
                .filter(|p| {
                    !array(&built.sent).iter().any(|sent| {
                        let abs = sent["abs"]
                            .as_str()
                            .map(PathBuf::from)
                            .unwrap_or_else(|| root.join(string(&sent["rel"])));
                        Path::new(string(p)) == abs
                            && s["flags"]["touched_at"][string(p)] == sent["touch_token"]
                    })
                })
                .cloned()
                .collect();
            s["touched"] = json!(keep);
        }
        Ok(())
    })?;
    record(rt, true, "")?;
    Ok(reply)
}
pub(super) fn stop(rt: &Runtime, payload: &Value, can_wake: bool, poll: bool) -> Result<Output> {
    let _ = ctrlc::set_handler(|| INTERRUPTED.store(true, Ordering::Relaxed));
    let key = state::key(payload);
    let Some(api_key) = rt.key()? else {
        return Ok(Output::default());
    };
    if let Some(p) = rt.paused(&api_key) {
        rt.session_mut(&key, |s| {
            state::note(
                s,
                if p["code"] == 426 {
                    "Intent Check: plugin update required; checks are paused."
                } else {
                    "Intent Check: API key rejected; checks are paused."
                },
                true,
                "info",
                Some("paused"),
            );
            Ok(())
        })?;
        return Ok(Output::default());
    }
    let api = Api::new(rt)?;
    let turn = payload["prompt_id"]
        .as_str()
        .or_else(|| payload["turn_id"].as_str())
        .unwrap_or("");
    let snap = payload::prompts_up_to(&rt.session(&key), turn);
    let mut changes = capture::collect(rt, &snap, &cwd(payload)?);
    if rt.live() {
        let current = rt.session(&key);
        changes.files.retain(|f| !covered(&current, f, false));
        rt.session_mut(&key, |s| {
            let jobs: Vec<_> = s["edit_jobs"]
                .as_object()
                .map(|m| {
                    m.values()
                        .filter(|j| {
                            j["settled"] != true
                                && now().saturating_sub(number(&j["submitted_at"])) < 86400000
                        })
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            for mut job in jobs {
                job["wake"] = json!(can_wake);
                if !array(&s["pending"])
                    .iter()
                    .any(|p| p["job_id"] == job["job_id"])
                {
                    state::push(&mut s["pending"], job, 100);
                }
            }
            Ok(())
        })?;
    }
    let queued = scan::queued(&changes.root)?;
    let paths: Vec<_> = queued
        .iter()
        .flat_map(|(_, q)| array(&q["paths"]).iter().map(string))
        .collect();
    changes.files.retain(|f| !paths.contains(&f.rel.as_str()));
    let turn = if turn.is_empty() {
        snap["turn_id"].as_str().unwrap_or("turn")
    } else {
        turn
    };
    let mut jobs = Vec::new();
    let built = payload::build(
        rt,
        &changes.root,
        &changes.files,
        payload::BuildContext {
            snap: &snap,
            stop: payload,
            key: &key,
            turn,
            mode: "edit",
            edit: false,
        },
    );
    let build_result = (|| -> Result<()> {
        if let Some(built) = built? {
            let idem = payload::idem(&key, turn, &built.sent);
            jobs.push((built, idem, None));
        }
        for (file, q) in &queued {
            let base = q["worktree"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| changes.root.clone());
            let files: Vec<_> = array(&q["paths"])
                .iter()
                .filter_map(|rel| scan::checked_file(&base, &base, string(rel)).ok())
                .map(|mut f| {
                    f.changed = 0;
                    f.worktree = q["worktree"].is_string();
                    f
                })
                .collect();
            if let Some(built) = payload::build(
                rt,
                &changes.root,
                &files,
                payload::BuildContext {
                    snap: &snap,
                    stop: payload,
                    key: &key,
                    turn: &format!("{turn}:request"),
                    mode: "request",
                    edit: false,
                },
            )? {
                let queue_id = file.file_stem().unwrap_or_default().to_string_lossy();
                let idem = payload::idem("queue", &queue_id, &built.sent);
                jobs.push((built, idem, Some((file.clone(), q.clone()))));
            } else {
                let _ = fs::remove_file(file);
            }
        }
        Ok(())
    })();
    if let Err(error) = build_result {
        record(rt, false, &error.to_string())?;
        rt.session_mut(&key, |s| {
            state::note(
                s,
                &format!("Intent Check: review did not start: {error}"),
                true,
                "info",
                Some("requirements_context"),
            );
            Ok(())
        })?;
        return Ok(Output::default());
    }
    let submit_start = Instant::now();
    if !jobs
        .iter()
        .any(|(built, _, _)| built.request["mode"] == "edit")
    {
        clear_captured_paths(rt, &key, &snap)?;
    }
    let budget: u64 = if rt.host == "codex" { 15000 } else { 840000 };
    for (built, idem, queued) in jobs {
        let left = budget.saturating_sub(submit_start.elapsed().as_millis() as u64);
        if left < 1000 || INTERRUPTED.load(Ordering::Relaxed) {
            break;
        }
        let r = submit(
            rt,
            &api,
            Submission {
                key: &key,
                root: &changes.root,
                built: &built,
                idem: &idem,
                payload,
                edit: false,
                wake: can_wake,
                timeout: left.min(if rt.host == "codex" { 8000 } else { 20000 }),
            },
        )?;
        if let Some((file, mut q)) = queued {
            if r.status == 202 {
                let _ = fs::remove_file(file);
            } else if r.status >= 500 || (r.status == 0 && r.code() == "timeout") {
                q["attempts"] = json!(number(&q["attempts"]) + 1);
                if number(&q["attempts"]) >= 3 {
                    fs::remove_file(file)?;
                    rt.session_mut(&key, |s| {
                        state::note(
                            s,
                            "Intent Check: gave up on a requested review after 3 failed attempts.",
                            true,
                            "info",
                            None,
                        );
                        Ok(())
                    })?;
                } else {
                    state::write(&file, &q, false)?;
                }
            } else if r.status != 0 && ![401, 426, 429].contains(&r.status) {
                let _ = fs::remove_file(file);
            }
        }
        if r.status == 202 {
            if !poll {
                let _ = rt.spawn("finish", &key);
            }
        } else if r.status == 0 || [401, 426, 429].contains(&r.status) {
            break;
        }
    }
    if changes.files.is_empty() && !changes.skipped.is_empty() {
        rt.session_mut(&key,|s|{state::note(s,&format!("Intent Check: skipped {} (styling, markup, tests, config or vendored code); it checks code with logic.",changes.skipped.join(", ")),true,"skipped",Some("skipped"));Ok(())})?;
    }
    let mut out = Output::default();
    if poll {
        poll_loop(
            rt,
            &key,
            can_wake,
            rt.started + Duration::from_millis(840000),
            false,
        )?;
    } else {
        if !array(&rt.session(&key)["pending"]).is_empty() {
            let _ = rt.spawn("finish", &key);
        }
        late(rt, &key)?;
    }
    let allow = if rt.host == "codex" {
        payload["stop_hook_active"] != true
    } else {
        can_wake
    };
    if allow {
        out = state::lease_notes(
            rt,
            &key,
            Some(if rt.host == "codex" || rt.live() {
                "concerns"
            } else {
                "wake"
            }),
        )?;
        if !out.context.is_empty() {
            out.exit = 2;
            out.summary = "Intent Check found concerns".into();
        }
    }
    Ok(out)
}
fn clear_captured_paths(rt: &Runtime, key: &str, snap: &Value) -> Result<()> {
    rt.session_mut(key, |s| {
        let keep: Vec<_> = array(&s["touched"])
            .iter()
            .filter(|p| {
                !array(&snap["touched"]).contains(p)
                    || s["flags"]["touched_at"][string(p)] != snap["flags"]["touched_at"][string(p)]
            })
            .cloned()
            .collect();
        s["touched"] = json!(keep);
        let paths = array(&s["touched"]).to_vec();
        if let Some(map) = s["patches"].as_object_mut() {
            map.retain(|p, _| paths.iter().any(|v| v == p));
        }
        if let Some(map) = s["flags"]["touched_at"].as_object_mut() {
            map.retain(|p, _| paths.iter().any(|v| v == p));
        }
        Ok(())
    })
}
fn settle(rt: &Runtime, key: &str, job: &Value, status: &Value, can_wake: bool) -> Result<bool> {
    let root = Path::new(string(&job["repo"]));
    let id = string(&job["job_id"]);
    let result = &status["result"];
    let bound = status["status"] == "done"
        && array(&result["units"]).iter().all(|u| {
            array(&job["sent"])
                .iter()
                .any(|s| s["rel"] == u["path"] && s["sha256"] == u["checked_sha256"])
        });
    let saved = (|| -> Result<()> {
        let dir = run_dir(root, id)?;
        state::write(
            &dir.join("result.json"),
            &json!({"version":1,"operation":"check","status":status["status"],"result":result,"error":status["error"],"bindings_valid":bound,"evidence_level":if bound{"llm_reviewed"}else{"unchecked"}}),
            false,
        )?;
        for unit in array(&result["units"]) {
            if !array(&job["sent"])
                .iter()
                .any(|s| s["rel"] == unit["path"] && s["sha256"] == unit["checked_sha256"])
            {
                continue;
            }
            let path = string(&unit["path"]);
            crate::requirements::relative_path(path)?;
            let dir = root
                .join(".intent/files")
                .join(path)
                .join("checks")
                .join(id);
            crate::storage::safe_parent(root, &dir)?;
            fs::create_dir_all(&dir)?;
            for name in protocol::ART {
                if let Some(text) = unit["artifacts"][name].as_str().filter(|s| {
                    !(*name == "SEMANTICS.k" && s.trim_start().starts_with("// Not generated"))
                }) {
                    let path = dir.join(name);
                    crate::storage::safe_parent(root, &path)?;
                    fs::write(path, text)?;
                }
            }
            state::write(
                &dir.join("meta.json"),
                &json!({"version":1,"path":path,"source_sha256":unit["checked_sha256"],"reviewed_at":result["checked_at"],"review_id":id,"submitted_at":job["submitted_at"],"result_ref":format!("runs/{id}/result.json"),"url":job["url"],"evidence_level":if unit["partial"]==true{"unchecked"}else{"llm_reviewed"},"verdict":unit["verdict"],"partial":unit["partial"]==true,"task_partial":result["partial"]==true,"claims":unit["claims"],"versions":{"plugin":rt.version,"contract":"1"}}),
                false,
            )?;
        }
        Ok(())
    })();
    if let Err(error) = saved {
        rt.log(
            "intentdir.write_failed",
            json!({"job":id,"error":error.to_string()}),
        );
    }
    let wake=rt.session_mut(key,|s|{
        let pending=array(&s["pending"]).iter().any(|p|p["job_id"]==id);
        let edit=job["edit"]==true && s["edit_jobs"][id].is_object() && s["edit_jobs"][id]["settled"]!=true;
        if !pending && !edit {return Ok(false);}
        s["pending"].as_array_mut().context("Pending jobs must be an array")?.retain(|j|j["job_id"]!=id);
        if edit {if result.is_object(){s["edit_jobs"][id]["settled"]=json!(true);}else{state::remove(&mut s["edit_jobs"],id);}}
        if !result.is_object() {
            if status["status"]=="failed" {let text=if status["error"]["code"]=="SPEND_CAP"{"Intent Check: today's free check limit was reached, so recent changes were not checked. Checks resume tomorrow.".into()}else{format!("Intent Check could not finish checking your changes, so there is no report for it. Run intent-check review with the files to try again. · {}",string(&job["url"]))};state::note(s,&text,true,"failed",None);}return Ok(false);
        }
        let concerns=render::concerns(result,&job["sent"]);
        if !s["flags"]["delivered"].is_object(){s["flags"]["delivered"]=json!({});}
        s["flags"]["delivered"].as_object_mut().expect("Delivery map").retain(|_,v|now().saturating_sub(number(v))<3600000);
        if concerns.is_empty() {state::note(s,&format!("Intent Check: no concerns in {}{} · {}",array(&job["sent"]).iter().map(|p|string(&p["rel"])).collect::<Vec<_>>().join(", "),if result["partial"]==true{" (partial review)"}else{""},string(&job["url"])),true,"quiet",None);return Ok(false);}
        let fresh:Vec<_>=concerns.into_iter().filter(|c|s["flags"]["delivered"][hash(format!("{}\n{}\n{}",string(&c["path"]),string(&c["type"]),string(&c["title"])))].is_null()).collect();
        if fresh.is_empty(){return Ok(false);}
        for c in &fresh{s["flags"]["delivered"][hash(format!("{}\n{}\n{}",string(&c["path"]),string(&c["type"]),string(&c["title"])))]=json!(now());}
        let text=render::concern_text(rt,job,result,&fresh);
        s["wakes"].as_array_mut().context("Invalid wakes")?.retain(|t|now().saturating_sub(number(t))<120000);
        s["woken"].as_object_mut().context("Invalid per-file wakes")?.retain(|_,v|now().saturating_sub(number(v))<600000);
        let wake=can_wake && job["wake"]!=false && array(&s["wakes"]).len()<3 && !fresh.iter().any(|c|!s["woken"][string(&c["path"])].is_null());
        if wake{state::push(&mut s["wakes"],json!(now()),3);for c in &fresh{s["woken"][string(&c["path"])]=json!(now());}}
        state::note(s,&text,false,"concerns",None);
        if let Some(note)=s["notes"].as_array_mut().and_then(|a|a.last_mut()){note["wake"]=json!(wake);}
        Ok(wake)
    })?;
    if status["status"] == "failed" {
        record(
            rt,
            false,
            &format!(
                "check failed on the service ({})",
                string(&status["error"]["code"])
            ),
        )?;
    }
    Ok(wake)
}
fn poll_loop(rt: &Runtime, key: &str, wake: bool, deadline: Instant, finisher: bool) -> Result<()> {
    let token = id();
    rt.session_mut(key, |s| {
        s["owner"] = json!({"pid":std::process::id(),"token":token,"at":now()});
        Ok(())
    })?;
    let api = Api::new(rt)?;
    let mut delay = 2000;
    let result = (|| -> Result<()> {
        while Instant::now() < deadline && !INTERRUPTED.load(Ordering::Relaxed) {
            if rt.disabled().is_some() {
                break;
            }
            let current = rt.session(key);
            if current["owner"]["token"] != token {
                break;
            }
            let jobs: Vec<_> = array(&current["pending"])
                .iter()
                .filter(|j| now().saturating_sub(number(&j["submitted_at"])) < 86400000)
                .cloned()
                .collect();
            if jobs.is_empty() {
                break;
            }
            for job in jobs {
                let r = api.check(string(&job["job_id"]), 10000);
                if r.ok()
                    && ["done", "failed", "superseded"].contains(&string(&r.body["status"]))
                    && settle(rt, key, &job, &r.body, wake)?
                {
                    return Ok(());
                } else if [401, 404].contains(&r.status) {
                    rt.session_mut(key, |s| {
                        s["pending"]
                            .as_array_mut()
                            .context("Invalid pending")?
                            .retain(|p| p["job_id"] != job["job_id"]);
                        state::remove(&mut s["edit_jobs"], string(&job["job_id"]));
                        Ok(())
                    })?;
                }
            }
            thread::sleep(
                Duration::from_millis(delay)
                    .min(deadline.saturating_duration_since(Instant::now())),
            );
            delay = (delay * 3 / 2).min(15000);
        }
        Ok(())
    })();
    rt.session_mut(key, |s| {
        if s["owner"]["token"] == token {
            s["owner"] = Value::Null;
        }
        Ok(())
    })?;
    if !finisher && !array(&rt.session(key)["pending"]).is_empty() {
        let _ = rt.spawn("finish", key);
    }
    result
}
fn late(rt: &Runtime, key: &str) -> Result<()> {
    rt.session_mut(key, |s| {
        s["pending"]
            .as_array_mut()
            .context("Pending jobs array")?
            .retain(|j| now().saturating_sub(number(&j["submitted_at"])) < 86400000);
        Ok(())
    })?;
    let current = rt.session(key);
    if state::alive(number(&current["owner"]["pid"])) || rt.key()?.is_none() {
        return Ok(());
    }
    if now().saturating_sub(number(&rt.global()["backoff"]["jobs"])) < 120000 {
        return Ok(());
    }
    let api = Api::new(rt)?;
    let deadline = Instant::now() + Duration::from_millis(1200);
    let mut failed = true;
    let mut tried = false;
    for job in array(&current["pending"]).iter().rev().take(5) {
        if Instant::now() >= deadline {
            break;
        }
        tried = true;
        let r = api.check(
            string(&job["job_id"]),
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .max(1) as u64,
        );
        failed &= r.status == 0 || r.status >= 500;
        if r.ok() && ["done", "failed", "superseded"].contains(&string(&r.body["status"])) {
            settle(rt, key, job, &r.body, false)?;
        } else if [401, 404].contains(&r.status) {
            rt.session_mut(key, |s| {
                s["pending"]
                    .as_array_mut()
                    .context("Pending jobs array")?
                    .retain(|j| j["job_id"] != job["job_id"]);
                state::remove(&mut s["edit_jobs"], string(&job["job_id"]));
                Ok(())
            })?;
        }
    }
    if tried {
        rt.global_mut(|g| {
            if !g["backoff"].is_object() {
                g["backoff"] = json!({});
            }
            if failed {
                g["backoff"]["jobs"] = json!(now());
            } else {
                state::remove(&mut g["backoff"], "jobs");
            }
            Ok(())
        })?;
    }
    Ok(())
}
pub(super) fn worker(rt: &Runtime, action: &str, argument: &str) -> Result<()> {
    let _ = ctrlc::set_handler(|| INTERRUPTED.store(true, Ordering::Relaxed));
    if action == "lsp" {
        if rt.disabled().is_none() {
            match crate::lsp::refresh(Path::new(argument), &rt.config.lsp, interrupted) {
                Ok(result) => rt.log("lsp.finished", result),
                Err(error) => rt.log("lsp.failed", json!({"message":format!("{error:#}")})),
            }
        }
        return Ok(());
    }
    if action == "finish" {
        anyhow::ensure!(
            re(r"^[0-9a-f]{32}$").is_match(argument),
            "Invalid session key"
        );
        return poll_loop(
            rt,
            argument,
            false,
            Instant::now() + Duration::from_secs(1800),
            true,
        );
    }
    if action == "scan" {
        return scan::wait(rt, argument);
    }
    let path = PathBuf::from(argument);
    anyhow::ensure!(
        path.starts_with(rt.data.join("tmp")),
        "Invalid worker payload path"
    );
    let payload = state::read(&path);
    let _ = fs::remove_file(&path);
    let key = state::key(&payload);
    match action {
        "stop" => {
            stop(rt, &payload, false, true)?;
        }
        "edit" => {
            let result = edit(rt, &payload);
            release_edit(rt, &key, string(&payload["reserve_id"]))?;
            result?;
        }
        "shell" => {
            for pass in 0..3 {
                if rt.disabled().is_some() || !rt.live() {
                    break;
                }
                let snap = rt.session(&key);
                let changes = capture::collect(rt, &snap, &cwd(&payload)?);
                for file in &changes.files {
                    let current = rt.session(&key);
                    if covered(&current, file, true)
                        || current["flags"]["shell_seen"][&file.rel] == hash(&file.bytes)
                    {
                        continue;
                    }
                    let mut job = payload.clone();
                    job["path"] = json!(file.abs);
                    job["tool_use_id"] = json!(format!("bash-{}", id()));
                    if !spawn_edit(rt, &job)? {
                        break;
                    }
                    rt.session_mut(&key, |s| {
                        if !s["flags"]["shell_seen"].is_object() {
                            s["flags"]["shell_seen"] = json!({});
                        }
                        s["flags"]["shell_seen"][&file.rel] = json!(hash(&file.bytes));
                        Ok(())
                    })?;
                }
                let again = rt.session_mut(&key, |s| {
                    let again = s["flags"]["shell_scan"]["again"] == true && pass < 2;
                    s["flags"]["shell_scan"] = if again {
                        json!({"at":now(),"again":false})
                    } else {
                        Value::Null
                    };
                    Ok(again)
                })?;
                if !again {
                    break;
                }
            }
        }
        _ => bail!("Unknown worker kind"),
    }
    Ok(())
}
fn edit(rt: &Runtime, payload: &Value) -> Result<()> {
    if rt.disabled().is_some() || !rt.live() {
        return Ok(());
    }
    let Some(api_key) = rt.key()? else {
        return Ok(());
    };
    if rt.paused(&api_key).is_some() {
        return Ok(());
    }
    let key = state::key(payload);
    let snap = payload::prompts_up_to(&rt.session(&key), string(&payload["prompt_id"]));
    let mut changes = capture::collect(rt, &snap, &cwd(payload)?);
    changes
        .files
        .retain(|f| f.abs == Path::new(string(&payload["path"])));
    if changes
        .files
        .iter()
        .any(|f| covered(&rt.session(&key), f, false))
    {
        return Ok(());
    }
    let turn = snap["turn_id"].as_str().unwrap_or("turn");
    let Some(built) = payload::build(
        rt,
        &changes.root,
        &changes.files,
        payload::BuildContext {
            snap: &snap,
            stop: payload,
            key: &key,
            turn,
            mode: "edit",
            edit: true,
        },
    )?
    else {
        return Ok(());
    };
    let api = Api::new(rt)?;
    let r = submit(
        rt,
        &api,
        Submission {
            key: &key,
            root: &changes.root,
            built: &built,
            idem: &payload::idem(
                &key,
                &format!("edit:{}", string(&payload["tool_use_id"])),
                &built.sent,
            ),
            payload,
            edit: true,
            wake: false,
            timeout: 20000,
        },
    )?;
    if r.status != 202 {
        return Ok(());
    }
    release_edit(rt, &key, string(&payload["reserve_id"]))?;
    let id = string(&r.body["id"]);
    let deadline = Instant::now() + Duration::from_secs(1800);
    let mut delay = 2000;
    while Instant::now() < deadline && !INTERRUPTED.load(Ordering::Relaxed) {
        if rt.disabled().is_some() {
            break;
        }
        let s = rt.session(&key);
        let job = &s["edit_jobs"][id];
        if job.is_null()
            || job["settled"] == true
            || array(&s["pending"]).iter().any(|p| p["job_id"] == id)
        {
            break;
        }
        let r = api.check(id, 10000);
        if r.ok() && ["done", "failed", "superseded"].contains(&string(&r.body["status"])) {
            settle(rt, &key, job, &r.body, false)?;
            break;
        }
        if [401, 404].contains(&r.status) {
            rt.session_mut(&key, |s| {
                state::remove(&mut s["edit_jobs"], id);
                Ok(())
            })?;
            break;
        }
        thread::sleep(Duration::from_millis(delay));
        delay = (delay * 3 / 2).min(15000);
    }
    Ok(())
}
