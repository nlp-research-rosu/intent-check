use super::*;
use capture::FileChange;

pub(super) struct Built {
    pub request: Value,
    pub sent: Value,
    pub binding: Value,
    pub redactions: u64,
}
pub(super) fn binding(context: &Value) -> Value {
    json!({"version":1,"kind":"consumed_context","brief":context["brief"].as_str().filter(|s|!s.is_empty()).map(|s|json!({"source_sha256":hash(s)})),"records":array(&context["requirements"]).iter().map(|r|json!({"id":r["id"],"record_sha256":hash(r.to_string())})).collect::<Vec<_>>(),"excluded":[]})
}
pub(super) fn notes(
    context: &Value,
    paths: &[String],
    redactor: &redact::Redactor,
) -> (Option<String>, Value, u64) {
    let mut binding =
        json!({"version":1,"kind":"consumed_context","brief":null,"records":[],"excluded":[]});
    let mut text = String::new();
    let mut count = 0;
    if let Some(brief) = context["brief"].as_str().filter(|s| !s.is_empty()) {
        let (r, n) = redactor.text(brief);
        count += n;
        text = clip(&r, 4000);
        binding["brief"] =
            json!({"source_sha256":hash(brief),"submitted_sha256":hash(&text),"partial":text!=r});
    }
    for record in array(&context["requirements"]) {
        if !array(&record["targets"])
            .iter()
            .any(|target| paths.iter().any(|p| target["path"] == *p))
        {
            continue;
        }
        let (r, n) = redactor.text(&record.to_string());
        count += n;
        let part = format!(
            "{}Structured requirement:\n{r}",
            if text.is_empty() { "" } else { "\n\n" }
        );
        if text.encode_utf16().count() + part.encode_utf16().count() > 4000 {
            state::push(
                &mut binding["excluded"],
                json!({"id":record["id"],"reason":"context_limit"}),
                usize::MAX,
            );
            continue;
        }
        text.push_str(&part);
        state::push(
            &mut binding["records"],
            json!({"id":record["id"],"record_sha256":hash(record.to_string()),"submitted_sha256":hash(&r)}),
            usize::MAX,
        );
    }
    ((!text.is_empty()).then_some(text), binding, count)
}
fn prior(root: &Path, rel: &str, redactor: &redact::Redactor) -> Option<Value> {
    let base = crate::storage::intent(root, false).ok()?;
    let checks = base.join("files").join(rel).join("checks");
    crate::storage::safe_parent(root, &checks).ok()?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&checks).ok()?.flatten() {
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let path = entry.path().join("meta.json");
        let meta = fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > 65536 {
            continue;
        }
        let value = state::read(&path);
        if value["path"] == rel
            && value["review_id"] == entry.file_name().to_string_lossy().as_ref()
        {
            candidates.push((number(&value["submitted_at"]), entry.path(), value));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let (_, folder, meta) = candidates.first()?;
    let mut value = json!({"source_sha256":meta["source_sha256"]});
    let mut any = false;
    for (key, file) in [
        ("intent_md", "INTENT.md"),
        ("spec_k", "SPEC.k"),
        ("semantics_k", "SEMANTICS.k"),
        ("verification_k", "VERIFICATION.k"),
    ] {
        let path = folder.join(file);
        let text = (|| {
            crate::storage::safe_parent(root, &path).ok()?;
            let meta = fs::symlink_metadata(&path).ok()?;
            if !meta.is_file() || meta.len() > 65536 {
                return None;
            }
            Some(redactor.text(&fs::read_to_string(path).ok()?).0)
        })();
        any |= text.is_some();
        value[key] = json!(text);
    }
    any.then_some(value)
}
fn unit_content(content: &str, diff: Option<&str>) -> (String, bool, Option<Value>) {
    let lines: Vec<_> = content.lines().collect();
    if lines.len() <= 1500 {
        return (content.into(), false, None);
    }
    let mut ranges = Vec::<(usize, usize)>::new();
    for c in re(r"(?m)^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@").captures_iter(diff.unwrap_or("")) {
        let start = c[1].parse::<usize>().unwrap_or(1);
        let len = c
            .get(2)
            .and_then(|c| c.as_str().parse::<usize>().ok())
            .unwrap_or(1);
        if start <= lines.len() + 1 {
            let a = start.saturating_sub(40).max(1).min(lines.len());
            let b = (start + len.saturating_sub(1) + 40).min(lines.len());
            ranges.push((a, b));
        }
    }
    ranges.sort();
    let mut merged = Vec::<(usize, usize)>::new();
    for (a, b) in ranges {
        if let Some(last) = merged.last_mut().filter(|last| a <= last.1 + 1) {
            last.1 = last.1.max(b);
        } else {
            merged.push((a, b));
        }
    }
    if merged.is_empty() {
        merged.push((1, 1500));
    }
    merged.truncate(200);
    (
        merged
            .iter()
            .map(|(a, b)| lines[a - 1..*b].join("\n"))
            .collect::<Vec<_>>()
            .join("\n...\n"),
        true,
        Some(json!(
            merged
                .iter()
                .map(|(a, b)| json!({"start":a,"end":b}))
                .collect::<Vec<_>>()
        )),
    )
}
pub(super) fn prompts_up_to(s: &Value, turn: &str) -> Value {
    let prompts = array(&s["prompts"]);
    let ids = array(&s["prompt_ids"]);
    let n = if turn.is_empty() {
        prompts.len()
    } else {
        ids.iter()
            .rposition(|id| id == turn)
            .map(|i| i + 1)
            .unwrap_or(prompts.len())
    };
    let mut snap = s.clone();
    snap["prompts"] = json!(&prompts[..n.min(prompts.len())]);
    if ids
        .iter()
        .skip(n)
        .any(|id| !id.is_null() && *id == s["first_prompt_id"])
    {
        snap["first_prompt"] = Value::Null;
    }
    if !turn.is_empty() {
        snap["turn_id"] = json!(turn);
    }
    snap
}
pub(super) struct BuildContext<'a> {
    pub snap: &'a Value,
    pub stop: &'a Value,
    pub key: &'a str,
    pub turn: &'a str,
    pub mode: &'a str,
    pub edit: bool,
}
pub(super) fn build(
    rt: &Runtime,
    root: &Path,
    files: &[FileChange],
    context: BuildContext<'_>,
) -> Result<Option<Built>> {
    let BuildContext {
        snap,
        stop,
        key,
        turn,
        mode,
        edit,
    } = context;
    let redactor = redact::Redactor::new();
    let mut units = Vec::new();
    let mut sent = Vec::new();
    let mut changed = 0;
    let mut count = 0;
    let mut truncated = false;
    for f in files {
        if units.len() >= 10 {
            truncated = true;
            break;
        }
        if !units.is_empty() && changed + f.changed > 1500 {
            truncated = true;
            continue;
        }
        let (text, n) = redactor.text(&f.text);
        count += n;
        let diff = f.diff.as_ref().map(|s| {
            let (text, n) = redactor.diff(s, &f.text);
            count += n;
            text
        });
        let (content, cut, regions) = unit_content(&text, f.diff.as_deref());
        let mut unit = json!({"path":f.rel,"language":filter::language(&f.rel),"sha256":hash(&f.bytes),"diff":diff,"content":content,"content_truncated":cut,"prior":prior(root,&f.rel,&redactor)});
        if let Some(regions) = regions {
            unit["regions"] = regions;
        }
        units.push(unit);
        let mut s = json!({"rel":f.rel,"sha256":hash(&f.bytes),"bytes":f.bytes.len()});
        s["touch_token"] = snap["flags"]["touched_at"][f.abs.to_string_lossy().as_ref()].clone();
        if f.worktree {
            s["abs"] = json!(f.abs);
        }
        sent.push(s);
        changed += f.changed;
    }
    if units.is_empty() || (mode == "edit" && changed < 3) {
        return Ok(None);
    }
    let paths: Vec<_> = units
        .iter()
        .map(|u| string(&u["path"]).to_owned())
        .collect();
    let context=crate::requirements::context(root,&paths).context("Local requirements could not be validated; run intent-check requirements context in this project")?;
    let (notes, binding, n) = notes(&context, &paths, &redactor);
    count += n;
    let mut clean = |value: &Value, max: usize| -> Value {
        value
            .as_str()
            .map(|s| {
                let (t, n) = redactor.text(&clip(s, 200000));
                count += n;
                json!(clip(&t, max))
            })
            .unwrap_or(Value::Null)
    };
    let prompts: Vec<_> = array(&snap["prompts"])
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(|p| clean(p, 4000))
        .collect();
    let first = if array(&snap["prompts"]).contains(&snap["first_prompt"]) {
        Value::Null
    } else {
        clean(&snap["first_prompt"], 4000)
    };
    let modes = codex_modes(stop);
    let mut request = json!({"contract_version":"1","mode":mode,"host":rt.host,"host_version":host_version(stop),"plugin_version":clip(&rt.version,40),"os":if cfg!(windows){"win32"}else if cfg!(target_os="macos"){"darwin"}else{"linux"},"session_id":key,"turn_id":clip(turn,128),"permission_mode":if rt.host=="codex"{Value::Null}else{stop["permission_mode"].clone()},"codex_modes":if rt.host=="codex"{modes}else{Value::Null},"intent":{"prompts":prompts,"first_prompt":first,"plan":clean(&snap["plan"],8000),"todos":array(&snap["todos"]).iter().take(30).map(|t|clean(t,200)).collect::<Vec<_>>(),"agent_message":clean(&stop["last_assistant_message"],4000)},"units":units,"changed_lines":changed,"truncated":truncated || !array(&binding["excluded"]).is_empty() || binding["brief"]["partial"]==true});
    if edit {
        request["per_edit"] = json!(true);
    }
    if let Some(notes) = notes {
        request["intent"]["notes"] = json!(notes);
    }
    let mut binding = binding;
    while request.to_string().len() > 1048576 && array(&request["units"]).len() > 1 {
        request["units"]
            .as_array_mut()
            .expect("Request units")
            .pop();
        sent.pop();
        let paths: Vec<_> = array(&request["units"])
            .iter()
            .map(|u| string(&u["path"]).to_owned())
            .collect();
        let (text, b, _) = self::notes(&context, &paths, &redactor);
        binding = b;
        state::remove(&mut request["intent"], "notes");
        if let Some(text) = text {
            request["intent"]["notes"] = json!(text);
        }
        request["truncated"] = json!(true);
    }
    if request.to_string().len() > 1048576 {
        return Ok(None);
    }
    Ok(Some(Built {
        request,
        sent: json!(sent),
        binding,
        redactions: count,
    }))
}
pub(super) fn idem(key: &str, turn: &str, sent: &Value) -> String {
    hash(format!(
        "{key}\n{turn}\n{}",
        array(sent)
            .iter()
            .map(|s| format!("{}:{}", string(&s["rel"]), string(&s["sha256"])))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}
pub(super) fn transcript(payload: &Value, max: usize) -> String {
    use std::io::{Seek, SeekFrom};
    (|| -> Result<String> {
        let mut file = fs::File::open(string(&payload["transcript_path"]))?;
        let size = file.metadata()?.len();
        file.seek(SeekFrom::Start(size.saturating_sub(max as u64)))?;
        let mut bytes = Vec::new();
        file.take(max as u64).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into())
    })()
    .unwrap_or_default()
}
pub(super) fn codex_modes(payload: &Value) -> Value {
    let mut context = Value::Null;
    for len in [256 * 1024, 8 * 1024 * 1024] {
        for line in transcript(payload, len).lines().rev() {
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && value["type"] == "turn_context"
            {
                context = value["payload"].clone();
                break;
            }
        }
        if !context.is_null() {
            break;
        }
    }
    let bounded = |v: &Value| v.as_str().map(|s| clip(s, 64));
    json!({"approval_policy":bounded(&context["approval_policy"]),"sandbox":bounded(&context["sandbox_policy"]["type"]),"collaboration_mode":bounded(&context["collaboration_mode"]["mode"])})
}
pub(super) fn permission(rt: &Runtime, payload: &Value) -> Value {
    if rt.host != "codex" {
        return payload["permission_mode"].clone();
    }
    let modes = codex_modes(payload);
    json!(if modes["approval_policy"] == "never"
        && modes["sandbox"].is_string()
        && modes["sandbox"] != "read-only"
        && modes["collaboration_mode"] != "plan"
    {
        "bypassPermissions"
    } else {
        "default"
    })
}
fn host_version(payload: &Value) -> String {
    if let Ok(v) = env::var("CLAUDE_CODE_VERSION") {
        return clip(&v, 40);
    }
    re(r#""(?:version|cli_version)"\s*:\s*"(\d+\.\d+\.\d+[^"\n]{0,20})"#)
        .captures_iter(&transcript(payload, 65536))
        .last()
        .map(|c| clip(&c[1], 40))
        .unwrap_or_else(|| "unknown".into())
}
