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
        let log = state::login_output(&output)?;
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
    for path in &mut paths {
        *path = path.components().collect();
    }
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
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
    if r.status == 401 && rt.key()?.as_deref() != Some(used) {
        return Ok(());
    }
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
        401 if env::var("INTENT_API_KEY").is_ok() => {
            "Intent Check: INTENT_API_KEY was not accepted, so checks are paused. Set a valid environment key, or unset it and run intent-check login."
        }
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
    let once = if [401, 426].contains(&r.status) {
        format!("paused:{}", &hash(format!("{used}\n{}", rt.version))[..16])
    } else {
        format!("failure:{}:{}", r.status, r.code())
    };
    rt.session_mut(key, |s| {
        state::note(s, text, true, "info", Some(&once));
        Ok(())
    })
}
pub(super) fn run_dir(root: &Path, id: &str) -> Result<PathBuf> {
    anyhow::ensure!(crate::storage::valid_id(id), "Invalid local run ID");
    anyhow::ensure!(root.is_dir(), "Project folder no longer exists");
    crate::storage::intent(root, true)?;
    let dir = root.join(".intent/logs").join(id);
    crate::storage::safe_parent(root, &dir)?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}
pub(super) fn freeze_input(root: &Path, run: &str, name: &str, bytes: &[u8]) -> Result<Value> {
    crate::requirements::relative_path(name)?;
    let file = run_dir(root, run)?.join("inputs").join(name);
    crate::storage::safe_parent(root, &file)?;
    fs::create_dir_all(file.parent().context("Input folder")?)?;
    fs::write(&file, bytes)?;
    Ok(json!({"path":format!("logs/{run}/inputs/{name}"),"sha256":hash(bytes)}))
}
fn request_record(root: &Path, task: &str, built: &payload::Built) -> Result<String> {
    let _lock = crate::storage::lock(root)?;
    let id = crate::storage::new_id(root)?;
    let request = &built.request;
    let dir = run_dir(root, &id)?;
    let mut inputs = vec![freeze_input(
        root,
        &id,
        "units.json",
        &serde_json::to_vec(&request["units"])?,
    )?];
    if let Some(notes) = request["intent"]["notes"].as_str() {
        inputs.push(freeze_input(
            root,
            &id,
            "requirements.txt",
            notes.as_bytes(),
        )?);
    }
    state::write(
        &dir.join("request.json"),
        &json!({"version":1,"operation":"review","task_id":task,"inputs":inputs,"trigger":if request["mode"]=="request"{"request"}else if request["per_edit"]==true{"edit"}else{"turn"},"submitted_at":now(),"host":request["host"],"session_id":request["session_id"],"partial":request["truncated"],"submitted_context_sha256":request["intent"]["notes"].as_str().map(hash),"requirement_binding":built.binding,"sources":array(&request["units"]).iter().map(|u|json!({"path":u["path"],"source_sha256":u["sha256"],"submitted_sha256":hash(string(&u["content"])),"content_truncated":u["content_truncated"],"regions":u["regions"],"specs":array(&built.sent).iter().find(|s|s["rel"]==u["path"]).map(|s|&s["specs"])})).collect::<Vec<_>>()}),
        false,
    )?;
    Ok(id)
}
pub(super) fn audit(root: &Path, entry: Value) {
    let _ = (|| -> Result<()> {
        anyhow::ensure!(root.is_dir(), "Project folder no longer exists");
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
    let run = match request_record(root, id, built) {
        Ok(run) => Some(run),
        Err(error) => {
            rt.log("intentdir.write_failed", json!({"error":error.to_string()}));
            None
        }
    };
    let mut job = json!({"job_id":id,"run_id":run,"url":api.report(id),"repo":root,"mode":built.request["mode"],"sent":built.sent,"permission_mode":payload::permission(rt,payload),"host":rt.host,"turn_id":built.request["turn_id"],"submitted_at":now(),"wake":wake,"edit":edit});
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
                    "Intent Check: checks are paused because this plugin version is too old for the service. Update the intent plugin to resume."
                } else {
                    "Intent Check: checks are paused because the API key was not accepted. Set a valid key, or unset INTENT_API_KEY and run intent-check login."
                },
                true,
                "info",
                Some(&format!("paused:{}", string(&p["id"]))),
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
                            &format!("Intent Check: gave up on a requested review of {} file{} after 3 failed attempts.", array(&q["paths"]).len(), if array(&q["paths"]).len() == 1 { "" } else { "s" }),
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
        rt.session_mut(&key, |s| {
            state::note(
                s,
                &render::skipped(&changes.skipped),
                true,
                "skipped",
                Some("skipped"),
            );
            Ok(())
        })?;
    }
    let mut out = Output::default();
    if poll {
        if !poll_loop(
            rt,
            &key,
            can_wake,
            rt.started + Duration::from_millis(840000),
            false,
        )? {
            return Ok(Output::default());
        }
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
            if out.summary.is_empty() {
                out.summary = "Intent Check found concerns".into();
            }
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
        let run = job["run_id"]
            .as_str()
            .context("Review has no saved local operation")?;
        let dir = run_dir(root, run)?;
        state::write(
            &dir.join("result.json"),
            &json!({"version":1,"operation":"review","task_id":id,"status":status["status"],"result":result,"error":status["error"],"bindings_valid":bound,"evidence_level":if bound{"llm_reviewed"}else{"unchecked"}}),
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
            let dir = dir.join("artifacts").join(path);
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
                &json!({"version":1,"path":path,"source_sha256":unit["checked_sha256"],"reviewed_at":result["checked_at"],"review_id":id,"run_id":run,"submitted_at":job["submitted_at"],"result_ref":format!("logs/{run}/result.json"),"url":job["url"],"evidence_level":if unit["partial"]==true{"unchecked"}else{"llm_reviewed"},"verdict":unit["verdict"],"partial":unit["partial"]==true,"task_partial":result["partial"]==true,"claims":unit["claims"],"versions":{"plugin":rt.version,"contract":"1"}}),
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
            if status["status"]=="failed" {let text=if status["error"]["code"]=="SPEND_CAP"{"Intent Check: today's free check limit was reached, so recent changes were not checked. Checks resume tomorrow.".into()}else{render::failed(string(&job["url"]),&array(&job["sent"]).iter().map(|p|string(&p["rel"])).collect::<Vec<_>>())};state::note(s,&text,true,"failed",None);}return Ok(false);
        }
        let concerns=render::concerns(result,&job["sent"]);
        if !s["flags"]["delivered"].is_object(){s["flags"]["delivered"]=json!({});}
        s["flags"]["delivered"].as_object_mut().expect("Delivery map").retain(|_,v|now().saturating_sub(number(v))<3600000);
        if concerns.is_empty() {
            let paths = array(&job["sent"]).iter().map(|p|string(&p["rel"])).collect::<Vec<_>>();
            state::note(s,&render::no_concerns(string(&job["url"]),result["partial"]==true,&paths),true,"quiet",None);
            if let Some(note)=s["notes"].as_array_mut().and_then(|a|a.last_mut()) { note["userText"]=json!(render::no_concerns_user(string(&job["url"]),&paths)); }
            return Ok(false);
        }
        let fresh:Vec<_>=concerns.into_iter().filter(|c|s["flags"]["delivered"][hash(format!("{}\n{}\n{}",string(&c["path"]),string(&c["type"]),string(&c["title"])))].is_null()).collect();
        if fresh.is_empty(){return Ok(false);}
        for c in &fresh{s["flags"]["delivered"][hash(format!("{}\n{}\n{}",string(&c["path"]),string(&c["type"]),string(&c["title"])))]=json!(now());}
        let text=render::concern_text(rt,job,result,&fresh);
        s["wakes"].as_array_mut().context("Invalid wakes")?.retain(|t|now().saturating_sub(number(t))<120000);
        s["woken"].as_object_mut().context("Invalid per-file wakes")?.retain(|_,v|now().saturating_sub(number(v))<600000);
        let wake=can_wake && job["wake"]!=false && array(&s["wakes"]).len()<3 && !fresh.iter().any(|c|!s["woken"][string(&c["path"])].is_null());
        if wake{state::push(&mut s["wakes"],json!(now()),3);for c in &fresh{s["woken"][string(&c["path"])]=json!(now());}}
        state::note(s,&text,false,"concerns",None);
        if let Some(note)=s["notes"].as_array_mut().and_then(|a|a.last_mut()){note["wake"]=json!(wake);note["summary"]=json!(render::summary(&fresh));}
        Ok(wake)
    })?;
    if status["status"] == "failed" {
        record(
            rt,
            false,
            &format!(
                "check failed on the service ({}), job {id}",
                string(&status["error"]["code"])
            ),
        )?;
    }
    Ok(wake)
}
fn poll_loop(
    rt: &Runtime,
    key: &str,
    wake: bool,
    deadline: Instant,
    finisher: bool,
) -> Result<bool> {
    let token = id();
    let claimed = rt.session_mut(key, |s| {
        if finisher && state::alive(number(&s["owner"]["pid"])) {
            return Ok(false);
        }
        s["owner"] = json!({"pid":std::process::id(),"token":token,"at":now()});
        Ok(true)
    })?;
    if !claimed {
        return Ok(false);
    }
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
                if rt.session(key)["owner"]["token"] != token {
                    return Ok(());
                }
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
    let owned = rt.session_mut(key, |s| {
        let owned = s["owner"]["token"] == token;
        if owned {
            s["owner"] = Value::Null;
        }
        Ok(owned)
    })?;
    if owned && !finisher && !array(&rt.session(key)["pending"]).is_empty() {
        let _ = rt.spawn("finish", key);
    }
    result.map(|()| owned)
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
        )
        .map(|_| ());
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
                rt.log("shell.scan", json!({"pass":pass}));
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
                    if again {
                        s["flags"]["shell_scan"] = json!({"at":now(),"again":false});
                    } else {
                        state::remove(&mut s["flags"], "shell_scan");
                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::tests::Fixture;

    const REVIEW_ID: &str = "11111111-1111-1111-1111-111111111111";

    fn example(stub: bool) -> Value {
        serde_json::from_str(if stub {
            include_str!("../../../test/fixtures/api/examples/status-done-no-concerns.json")
        } else {
            include_str!("../../../test/fixtures/api/examples/status-done-concerns.json")
        })
        .expect("review fixture")
    }

    fn save(f: &Fixture, rel: &str, id: &str, stub: bool, submitted: u64) -> PathBuf {
        let mut status = example(stub);
        status["result"]["units"][0]["path"] = json!(rel);
        let unit = &status["result"]["units"][0];
        let run = hash(id)[..6].to_owned();
        let job = json!({"repo":f.root,"job_id":id,"run_id":run,"url":"https://x.test/report","submitted_at":submitted,"sent":[{"rel":rel,"sha256":unit["checked_sha256"]}]});
        settle(&f.rt, "storage", &job, &status, false).expect("settle review fixture");
        f.root
            .join(".intent/logs")
            .join(run)
            .join("artifacts")
            .join(rel)
    }

    #[test]
    fn stored_artifacts_metadata_and_generations_keep_their_bindings() {
        let f = Fixture::new();
        let rel = "src/billing/pricing.py";
        let dir = save(&f, rel, REVIEW_ID, false, 2000);
        let expected = example(false);
        let unit = &expected["result"]["units"][0];
        for name in ["INTENT.md", "SPEC.k", "SEMANTICS.k", "VERDICT.md"] {
            assert_eq!(
                fs::read_to_string(dir.join(name)).expect("stored artifact"),
                unit["artifacts"][name]
            );
        }
        let meta = state::read(&dir.join("meta.json"));
        assert_eq!(meta["source_sha256"], unit["checked_sha256"]);
        assert_eq!(meta["review_id"], REVIEW_ID);
        assert_eq!(meta["url"], "https://x.test/report");
        assert_eq!(meta["verdict"], "concerns");
        assert_eq!(meta["reviewed_at"], expected["result"]["checked_at"]);
        assert_eq!(meta["versions"]["plugin"], f.rt.version);
        assert!(
            !fs::read_dir(&dir)
                .expect("generation directory")
                .flatten()
                .any(|p| p.path().extension().is_some_and(|e| e == "tmp"))
        );
        let later = save(&f, rel, "22222222-2222-2222-2222-222222222222", true, 3000);
        let stub = example(true);
        for name in ["VERIFICATION.k", "REASONING.md"] {
            assert_eq!(
                fs::read_to_string(later.join(name)).expect("verification artifact"),
                stub["result"]["units"][0]["artifacts"][name]
            );
        }
        assert!(!later.join("SEMANTICS.k").exists());
        assert!(dir.join("SEMANTICS.k").exists());
        let old = save(&f, rel, "33333333-3333-3333-3333-333333333333", false, 1000);
        assert!(old.join("SEMANTICS.k").exists());
        assert!(!later.join("SEMANTICS.k").exists());
        assert_eq!(state::read(&later.join("meta.json"))["submitted_at"], 3000);
        assert_eq!(state::read(&dir.join("meta.json"))["submitted_at"], 2000);
    }

    #[test]
    fn scaffolding_preserves_existing_readmes_brief_requirements_and_mtimes() {
        let f = Fixture::new();
        crate::storage::intent(&f.root, true).expect("scaffold");
        assert_eq!(
            fs::read_to_string(f.root.join(".intent/.ignore")).expect("search ignore"),
            "*\n"
        );
        assert_eq!(
            fs::read_to_string(f.root.join(".intent/.gitignore")).expect("git ignore"),
            ".sent.log\n.queue\n.storage.lock\n"
        );
        let readme = f.root.join(".intent/README.md");
        assert_eq!(
            fs::read_to_string(&readme).expect("readme"),
            include_str!("../../../intent-storage.md")
        );
        let modified = fs::metadata(&readme)
            .expect("readme metadata")
            .modified()
            .expect("readme mtime");
        crate::storage::intent(&f.root, true).expect("repeat scaffold");
        assert_eq!(
            fs::metadata(&readme)
                .expect("readme metadata")
                .modified()
                .expect("readme mtime"),
            modified
        );
        for text in [
            "# .intent\n\nAn older version of this file.\n\n## Our team's rule\n\nAlways re-run the checks locally first.\n",
            "# My notes about .intent\n\nDo not touch this.\n",
        ] {
            fs::write(&readme, text).expect("existing readme");
            crate::storage::intent(&f.root, true).expect("preserve existing scaffold");
            assert_eq!(fs::read_to_string(&readme).expect("preserved readme"), text);
        }
        f.write(".intent/REQUIREMENTS.md", "- Kept on purpose.\n");
        f.write(
            ".intent/requirements.json",
            r#"{"version":1,"requirements":[]}"#,
        );
        save(&f, "pricing.py", REVIEW_ID, false, 1);
        assert_eq!(
            fs::read_to_string(f.root.join(".intent/REQUIREMENTS.md")).expect("brief"),
            "- Kept on purpose.\n"
        );
        assert_eq!(
            fs::read_to_string(f.root.join(".intent/requirements.json"))
                .expect("legacy requirements"),
            r#"{"version":1,"requirements":[]}"#
        );
        assert!(!f.root.join(".intent/NOTES.md").exists());
    }

    #[test]
    fn deleted_projects_and_unsafe_unit_paths_never_receive_evidence() {
        let f = Fixture::new();
        for path in [
            "../x.py",
            "/etc/passwd",
            "a/../../x.py",
            "C:/x.py",
            ".intent/x.py",
            ".git/config",
            "a//b.py",
            "",
            "a\nb.py",
        ] {
            let dir = save(&f, path, REVIEW_ID, false, 1);
            assert!(!dir.join("meta.json").exists(), "{path}");
        }
        let gone = f.root.join("gone");
        assert!(run_dir(&gone, "abc123").is_err());
        audit(&gone, json!({"time":"t"}));
        assert!(!gone.exists());
        assert!(
            !f.root
                .parent()
                .expect("fixture parent")
                .join("x.py")
                .exists()
        );
    }

    #[test]
    fn audit_holds_metadata_only_and_git_ignores_local_upload_log() {
        let f = Fixture::new();
        f.git(&["init", "-q"]);
        save(&f, "pricing.py", REVIEW_ID, false, 1);
        let entry = json!({"time":"2026-09-28T14:00:00Z","url":"https://x/intent-checks","paths":["pricing.py"],"bytes":981,"redactions":0});
        audit(&f.root, entry.clone());
        let text = fs::read_to_string(f.root.join(".intent/.sent.log")).expect("audit log");
        assert_eq!(
            serde_json::from_str::<Value>(text.trim()).expect("audit entry"),
            entry
        );
        let status = f.git(&["status", "--porcelain", "-uall"]);
        assert!(status.contains(&format!(
            ".intent/logs/{}/artifacts/pricing.py/SPEC.k",
            &hash(REVIEW_ID)[..6]
        )));
        assert!(status.contains(".intent/README.md"));
        assert!(!status.contains(".sent.log"));
        f.write("pricing.py", "def apply_discount(): pass\n");
        if let Ok(result) = Command::new("rg")
            .args(["-l", "apply_discount", "."])
            .current_dir(&f.root)
            .output()
        {
            assert!(result.status.success());
            assert_eq!(
                String::from_utf8_lossy(&result.stdout)
                    .trim()
                    .trim_start_matches("./"),
                "pricing.py"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn planted_source_folder_symlink_cannot_redirect_evidence() {
        let f = Fixture::new();
        let outside = Fixture::new();
        let artifacts = f
            .root
            .join(".intent/logs")
            .join(&hash(REVIEW_ID)[..6])
            .join("artifacts");
        fs::create_dir_all(&artifacts).expect("evidence parent");
        std::os::unix::fs::symlink(&outside.root, artifacts.join("src"))
            .expect("source folder link");
        save(&f, "src/pricing.py", REVIEW_ID, false, 1);
        assert_eq!(
            fs::read_dir(&outside.root).expect("outside folder").count(),
            0
        );
    }

    #[test]
    fn audit_never_appends_to_hard_linked_log() {
        let f = crate::runtime::tests::Fixture::new();
        let outside = crate::runtime::tests::Fixture::new();
        let profile = outside.write("profile", "# profile\n");
        crate::storage::intent(&f.root, true).expect("scaffold");
        fs::hard_link(&profile, f.root.join(".intent/.sent.log")).expect("hard link audit log");
        audit(&f.root, json!({"time":"t","paths":["x"]}));
        assert_eq!(fs::read_to_string(profile).expect("profile"), "# profile\n");
    }

    #[cfg(unix)]
    #[test]
    fn audit_never_follows_symlinked_log() {
        let f = crate::runtime::tests::Fixture::new();
        let outside = crate::runtime::tests::Fixture::new();
        let rc = outside.write("bashrc", "# rc\n");
        crate::storage::intent(&f.root, true).expect("scaffold");
        std::os::unix::fs::symlink(&rc, f.root.join(".intent/.sent.log"))
            .expect("symlink audit log");
        audit(&f.root, json!({"time":"t","paths":["$(curl evil)"]}));
        assert_eq!(fs::read_to_string(rc).expect("rc file"), "# rc\n");
    }

    #[cfg(unix)]
    #[test]
    fn evidence_writes_reject_symlinked_intent_without_touching_history() {
        let f = crate::runtime::tests::Fixture::new();
        let outside = crate::runtime::tests::Fixture::new();
        let old = outside.write("gone.py/VERDICT.md", "x");
        std::os::unix::fs::symlink(&outside.root, f.root.join(".intent"))
            .expect("link intent folder");
        let error = run_dir(&f.root, "abc123").expect_err("symlinked intent must be refused");
        assert!(error.to_string().contains("real directory"), "{error}");
        assert_eq!(fs::read_to_string(old).expect("preserved history"), "x");
        assert!(!outside.root.join("logs/abc123").exists());
    }

    #[test]
    fn patch_paths_keep_add_update_and_move_targets_not_deleted_or_moved_from() {
        let f = crate::runtime::tests::Fixture::new();
        let payload: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/codex/post-tool-apply-patch.json"
        ))
        .expect("Codex patch fixture");
        let util = Path::new("/work/proj/util.py");
        let util = if util.is_absolute() {
            util.to_path_buf()
        } else {
            f.root.join(util)
        };
        assert_eq!(
            tool_paths(&payload, &f.root),
            vec![
                f.root.join("calc.py"),
                util.components().collect::<PathBuf>(),
                f.root.join("new_name.py")
            ]
        );
        assert!(tool_paths(&json!({"tool_name":"apply_patch"}), &f.root).is_empty());
        let command = "*** Begin Patch\r\n*** Update File: old.py\r\n*** Move to: new.py\r\n@@\r\n-a\r\n+b\r\n*** Add File: x.py\r\n+1\r\n*** End Patch";
        assert_eq!(
            tool_paths(
                &json!({"tool_name":"apply_patch","tool_input":{"command":command}}),
                &f.root
            ),
            vec![f.root.join("new.py"), f.root.join("x.py")]
        );
    }
}
