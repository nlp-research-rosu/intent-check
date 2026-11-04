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
fn prior(
    root: &Path,
    rel: &str,
    redactor: &redact::Redactor,
) -> Result<(Option<Value>, Vec<Value>, u64)> {
    let context = crate::requirements::context(root, &[rel.to_owned()])?;
    let ids: std::collections::BTreeSet<_> = array(&context["requirements"])
        .iter()
        .filter_map(|record| record["id"].as_str())
        .collect();
    let mut paths = std::collections::BTreeSet::new();
    for (_, index) in crate::storage::indexes(root)? {
        for (id, selection) in index.properties {
            if ids.contains(id.as_str()) {
                paths.extend(selection.specs);
            }
        }
    }
    let mut groups = std::collections::BTreeMap::<&str, String>::new();
    let mut bindings = Vec::new();
    let mut redactions = 0;
    for path in paths {
        if !path.ends_with(".k") {
            continue;
        }
        let file = crate::storage::spec_path(root, &path)?;
        let Ok(meta) = fs::symlink_metadata(&file) else {
            continue;
        };
        if !meta.is_file() || meta.len() > 65536 {
            continue;
        }
        let Ok(raw) = fs::read_to_string(file) else {
            continue;
        };
        let (text, count) = redactor.text(&raw);
        let name = path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
        let key = if name.contains("verification") {
            "verification_k"
        } else if name.contains("semantics") {
            "semantics_k"
        } else {
            "spec_k"
        };
        let group = groups.entry(key).or_default();
        if group.len() + text.len() + 2 > 65536 {
            continue;
        }
        if !group.is_empty() {
            group.push_str("\n\n");
        }
        group.push_str(&text);
        redactions += count;
        bindings
            .push(json!({"path":path,"source_sha256":hash(&raw),"submitted_sha256":hash(&text)}));
    }
    let value = (!bindings.is_empty()).then(|| json!({"intent_md":null,"source_sha256":null,
        "spec_k":groups.get("spec_k"),"semantics_k":groups.get("semantics_k"),"verification_k":groups.get("verification_k")}));
    Ok((value, bindings, redactions))
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
        let (prior, specs, n) = prior(root, &f.rel, &redactor)?;
        count += n;
        let mut unit = json!({"path":f.rel,"language":filter::language(&f.rel),"sha256":hash(&f.bytes),"diff":diff,"content":content,"content_truncated":cut,"prior":prior});
        if let Some(regions) = regions {
            unit["regions"] = regions;
        }
        units.push(unit);
        let mut s =
            json!({"rel":f.rel,"sha256":hash(&f.bytes),"bytes":f.bytes.len(),"specs":specs});
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
    let context=crate::requirements::context(root,&paths).context("Local requirements could not be validated; run intent-check requirements list in this project")?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::tests::Fixture;

    fn file(f: &Fixture, rel: &str, text: &str, diff: Option<&str>) -> FileChange {
        let diff = diff
            .map(str::to_owned)
            .unwrap_or_else(|| capture::new_diff(rel, text));
        FileChange {
            rel: rel.into(),
            abs: f.root.join(rel),
            bytes: text.as_bytes().to_vec(),
            text: text.into(),
            changed: capture::changed(&diff),
            diff: Some(diff),
            worktree: false,
        }
    }

    fn build_files(f: &Fixture, files: &[FileChange]) -> Result<Option<Built>> {
        let snap = json!({"prompts":["Add a helper that applies a percentage discount. It should never go below zero.",format!("also use key sk-proj-{}", "Zq8".repeat(14))],"first_prompt":"Build me a pricing module for the shop","plan":"1. Add apply_discount","todos":["Add apply_discount","Clamp at zero"]});
        let stop = json!({"permission_mode":"acceptEdits","last_assistant_message":"Added apply_discount. It handles all the edge cases."});
        build(
            &f.rt,
            &f.root,
            files,
            BuildContext {
                snap: &snap,
                stop: &stop,
                key: "e43a48a0bbd65fcbe24d5a8b665b86a3",
                turn: "turn-3",
                mode: "edit",
                edit: false,
            },
        )
    }

    #[test]
    fn request_fields_hash_redaction_and_threshold() {
        let f = Fixture::new();
        let source = "# pricing.py\ndef apply_discount(price_cents: int, percent: int) -> int:\n    return price_cents - price_cents * percent // 100\n";
        let b = build_files(&f, &[file(&f, "pricing.py", source, None)])
            .expect("build request")
            .expect("eligible request");
        assert_eq!(b.request["mode"], "edit");
        assert_eq!(b.request["changed_lines"], 3);
        assert_eq!(
            b.request["units"][0]["sha256"],
            "a949e6048d964c91f2a1587532adda76e4348d987f3c78cdf6c47f5b7b94a510"
        );
        assert_eq!(
            b.request["intent"]["first_prompt"],
            "Build me a pricing module for the shop"
        );
        assert_eq!(
            b.request["intent"]["agent_message"],
            "Added apply_discount. It handles all the edge cases."
        );
        assert!(!b.request.to_string().contains("Zq8Zq8Zq8"));
        assert_eq!(b.redactions, 1);
        assert!(
            build_files(&f, &[file(&f, "a.py", "x = 1\ny = 2\n", None)])
                .expect("small request")
                .is_none()
        );
    }

    #[test]
    fn unit_and_changed_line_caps_drop_later_files() {
        let f = Fixture::new();
        let files: Vec<_> = (0..12)
            .map(|i| file(&f, &format!("m{i}.py"), "a\nb\nc\n", None))
            .collect();
        let b = build_files(&f, &files)
            .expect("build capped request")
            .expect("eligible request");
        assert_eq!(array(&b.request["units"]).len(), 10);
        assert_eq!(b.request["truncated"], true);
        let big = (0..1400)
            .map(|i| format!("x{i} = {i}\n"))
            .collect::<String>();
        let files = [
            file(&f, "big.py", &big, None),
            file(&f, "more.py", &"y = 1\n".repeat(200), None),
            file(&f, "c.py", "a\nb\nc\n", None),
        ];
        let b = build_files(&f, &files)
            .expect("build capped request")
            .expect("eligible request");
        assert_eq!(
            array(&b.request["units"])
                .iter()
                .map(|u| string(&u["path"]))
                .collect::<Vec<_>>(),
            vec!["big.py", "c.py"]
        );
        assert_eq!(b.request["truncated"], true);
    }

    #[test]
    fn touched_regions_preserve_line_coordinates_and_eof() {
        let body = |n| (1..=n).map(|i| format!("line {i}\n")).collect::<String>();
        for (n, diff, want) in [
            (
                3000,
                "@@ -100,1 +100,2 @@\n-line 100\n+line 100\n+line 101\n@@ -2500,0 +2501,1 @@\n+line 2501\n",
                json!([{"start":60,"end":141},{"start":2461,"end":2541}]),
            ),
            (
                3000,
                "@@ -2998,1 +2998,3 @@\n+a\n+b\n",
                json!([{"start":2958,"end":3000}]),
            ),
            (
                3000,
                "@@ -100,1 +100,1 @@\n-x\n+y\n@@ -2999,0 +3000,1 @@\n+z\n",
                json!([{"start":60,"end":140},{"start":2960,"end":3000}]),
            ),
            (
                3000,
                "@@ -3001,2 +3000,0 @@\n-gone\n-gone\n",
                json!([{"start":2960,"end":3000}]),
            ),
            (
                2000,
                "@@ -5000,1 +5000,1 @@\n-a\n+b\n",
                json!([{"start":1,"end":1500}]),
            ),
        ] {
            let (text, cut, regions) = unit_content(&body(n), Some(diff));
            assert!(cut, "{diff}");
            assert_eq!(regions, Some(want.clone()), "{diff}");
            let parts: Vec<_> = text.split("\n...\n").collect();
            assert_eq!(parts.len(), array(&want).len());
            for (part, range) in parts.iter().zip(array(&want)) {
                let a = number(&range["start"]);
                let b = number(&range["end"]);
                assert!(a >= 1 && a <= b && b <= n as u64, "{range}");
                assert_eq!(part.lines().count() as u64, b - a + 1);
                assert!(
                    part.starts_with(&format!("line {a}\n"))
                        && part.ends_with(&format!("line {b}")),
                    "{range}"
                );
            }
            assert!(!text.ends_with('\n'));
        }
        let content = body(1500);
        assert_eq!(
            unit_content(&content, Some("@@ -1,1 +1,1 @@\n-a\n+b\n")),
            (content.clone(), false, None)
        );
        assert!(unit_content(&(content + "extra\n"), None).1);
        let f = Fixture::new();
        let b = build_files(
            &f,
            &[file(
                &f,
                "big.py",
                &body(2000),
                Some("@@ -1000,1 +1000,1 @@\n-a\n+b\n@@ -1500,0 +1500,1 @@\n+x\n"),
            )],
        )
        .expect("build regions")
        .expect("eligible request");
        assert_eq!(
            b.request["units"][0]["regions"],
            json!([{"start":960,"end":1040},{"start":1460,"end":1540}])
        );
        assert_eq!(b.request["units"][0]["content_truncated"], true);
        let small = build_files(&f, &[file(&f, "s.py", "a\nb\nc\n", None)])
            .expect("small build")
            .expect("small request");
        assert!(small.request["units"][0].get("regions").is_none());
    }

    #[test]
    fn prior_reads_selected_formal_files_and_optional_verification() {
        let f = Fixture::new();
        for (i, name) in ["status-done-concerns.json", "status-done-no-concerns.json"]
            .iter()
            .enumerate()
        {
            let raw = fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../test/fixtures/api/examples")
                    .join(name),
            )
            .expect("read fixture");
            let ex: Value = serde_json::from_slice(&raw).expect("parse fixture");
            let unit = &ex["result"]["units"][0];
            let dir = format!(".intent/source/pricing.py/specs/def45{i}");
            crate::storage::intent(&f.root, true).expect("scaffold");
            f.write(".intent/source/pricing.py/requirements.json",r#"{"schema_version":1,"requirements":[{"id":"abc123","statement":"Prices stay nonnegative","targets":[{"path":"pricing.py"}]}]}"#);
            let mut specs = Vec::new();
            for (name, text) in unit["artifacts"].as_object().expect("fixture artifacts") {
                f.write(&format!("{dir}/{name}"), string(text));
                if name.ends_with(".k") && !string(text).starts_with("// Not generated") {
                    specs.push(format!("{}/{name}", dir.trim_start_matches(".intent/")));
                }
            }
            f.write(".intent/source/pricing.py/index.json",&json!({"schema_version":1,"properties":{"abc123":{"specs":specs,"last_run":null}}}).to_string());
            let (p, bindings, _) =
                prior(&f.root, "pricing.py", &redact::Redactor::new()).expect("prior artifacts");
            let p = p.expect("selected specs");
            assert!(p["source_sha256"].is_null());
            assert!(!bindings.is_empty());
            assert!(string(&p["spec_k"]).contains("PRICING-SPEC"));
            if i == 0 {
                assert!(p["verification_k"].is_null());
            } else {
                assert!(string(&p["verification_k"]).contains("PRICING-VERIFICATION"));
                assert!(string(&p["verification_k"]).contains("floordiv"));
            }
            let b = build_files(&f, &[file(&f, "pricing.py", "a\nb\nc\n", None)])
                .expect("build with prior")
                .expect("request");
            assert_eq!(b.request["units"][0]["prior"], p);
        }
        assert!(
            prior(&f.root, "other.py", &redact::Redactor::new())
                .expect("unrelated prior")
                .0
                .is_none()
        );
    }

    #[test]
    fn prior_artifacts_ignore_oversized_and_symlinked_files_and_redact_contents() {
        let f = Fixture::new();
        f.write(
            ".intent/source/app.py/requirements.json",
            r#"{"schema_version":1,"requirements":[{"id":"abc123","statement":"App property","targets":[{"path":"app.py"}]}]}"#,
        );
        f.write(".intent/source/app.py/index.json",r#"{"schema_version":1,"properties":{"abc123":{"specs":["source/app.py/specs/def456/SPEC.k","source/app.py/specs/def456/SEMANTICS.k"],"last_run":null}}}"#);
        f.write(
            ".intent/source/app.py/specs/def456/SPEC.k",
            &"x".repeat(70 * 1024),
        );
        f.write(
            ".intent/source/app.py/specs/def456/SEMANTICS.k",
            "token = \"Xk29fLq8Zr4Tw7Vb\"\n",
        );
        let p = prior(&f.root, "app.py", &redact::Redactor::new())
            .expect("prior semantics")
            .0
            .expect("selected semantics");
        assert!(p["intent_md"].is_null());
        assert!(p["spec_k"].is_null());
        assert!(!string(&p["semantics_k"]).contains("Xk29fLq8Zr4Tw7Vb"));
        #[cfg(unix)]
        {
            let outside = Fixture::new();
            let credentials =
                outside.write("credentials", "aws_secret_access_key = Xk29fLq8Zr4Tw7Vb\n");
            std::os::unix::fs::symlink(
                credentials,
                f.root.join(".intent/source/app.py/specs/def456/INTENT.md"),
            )
            .expect("symlink prior artifact");
            let p = prior(&f.root, "app.py", &redact::Redactor::new())
                .expect("prior semantics")
                .0
                .expect("selected semantics");
            assert!(p["intent_md"].is_null());
            std::os::unix::fs::symlink(f.root.join(".intent"), outside.root.join(".intent"))
                .expect("symlink intent root");
            assert!(prior(&outside.root, "app.py", &redact::Redactor::new()).is_err());
        }
    }

    #[test]
    fn prior_uses_current_selection_instead_of_historical_arrival() {
        let f = Fixture::new();
        f.write(".intent/source/a.py/requirements.json",r#"{"schema_version":1,"requirements":[{"id":"abc123","statement":"A property","targets":[{"path":"a.py"}]}]}"#);
        f.write(".intent/source/a.py/index.json",r#"{"schema_version":1,"properties":{"abc123":{"specs":["source/a.py/specs/def456/spec.k"],"last_run":null}}}"#);
        f.write(".intent/source/a.py/specs/def456/spec.k", "current");
        for (id, content) in [("111111", "new"), ("222222", "old")] {
            f.write(&format!(".intent/logs/{id}/artifacts/a.py/SPEC.k"), content);
            assert_eq!(
                prior(&f.root, "a.py", &redact::Redactor::new())
                    .expect("current prior")
                    .0
                    .expect("selected spec")["spec_k"],
                "current"
            );
        }
    }

    #[test]
    fn clipped_context_keeps_complete_unicode_and_removes_nuls() {
        let f = Fixture::new();
        let text = format!("{}😀tail", "a".repeat(3999));
        assert_eq!(clip(&text, 4000).encode_utf16().count(), 3999);
        let files = [file(&f, "a.py", "x = 1\ny = 2\nz = 3\n", None)];
        let snap = json!({"prompts":[text,"lone � and nul \0"]});
        let built = build(
            &f.rt,
            &f.root,
            &files,
            BuildContext {
                snap: &snap,
                stop: &json!({}),
                key: "s",
                turn: "t",
                mode: "edit",
                edit: false,
            },
        )
        .expect("build unicode request")
        .expect("unicode request");
        let bytes = built.request.to_string();
        assert!(!bytes.contains("\\u0000"));
        assert!(serde_json::from_str::<Value>(&bytes).is_ok());
        assert_eq!(redact::Redactor::new().text("a\0b�c").0, "ab�c");
    }

    #[test]
    fn brief_context_redaction_limits_and_consumed_bindings() {
        let f = Fixture::new();
        f.write(
            ".intent/REQUIREMENTS.md",
            &format!(
                "- Coupons intentionally never expire; the docstring is stale. Key sk-proj-{}\n",
                "Zq8".repeat(14)
            ),
        );
        let b = build_files(&f, &[file(&f, "pricing.py", "a\nb\nc\n", None)])
            .expect("build brief")
            .expect("request");
        assert!(
            string(&b.request["intent"]["notes"]).contains("Coupons intentionally never expire")
        );
        assert!(!string(&b.request["intent"]["notes"]).contains("Zq8Zq8Zq8"));
        f.write("pricing.py", "a\nb\nc\n");
        f.write(".intent/REQUIREMENTS.md", &"x".repeat(5000));
        f.write(".intent/source/pricing.py/requirements.json",r#"{"schema_version":1,"requirements":[{"id":"abc123","statement":"Prices remain nonnegative","targets":[{"path":"pricing.py","symbol":"apply_discount"}]}]}"#);
        let b = build_files(&f, &[file(&f, "pricing.py", "a\nb\nc\n", None)])
            .expect("limited brief")
            .expect("request");
        assert_eq!(string(&b.request["intent"]["notes"]).len(), 4000);
        assert_eq!(b.binding["brief"]["partial"], true);
        assert_eq!(b.request["truncated"], true);
        assert_eq!(b.binding["records"], json!([]));
        assert_eq!(
            b.binding["excluded"],
            json!([{"id":"abc123","reason":"context_limit"}])
        );
        for text in [None, Some("")] {
            let f = Fixture::new();
            if let Some(text) = text {
                f.write(".intent/REQUIREMENTS.md", text);
            }
            let b = build_files(&f, &[file(&f, "pricing.py", "a\nb\nc\n", None)])
                .expect("empty brief")
                .expect("request");
            assert!(b.request["intent"].get("notes").is_none());
        }
        let f = Fixture::new();
        f.write(".intent/REQUIREMENTS.md", &"x".repeat(1024 * 1024 + 1));
        assert!(build_files(&f, &[file(&f, "pricing.py", "a\nb\nc\n", None)]).is_err());
    }

    #[test]
    fn idempotency_depends_on_session_turn_paths_and_hashes() {
        let sent = json!([{"rel":"a.py","sha256":"1"}]);
        let a = idem("s", "t", &sent);
        assert_eq!(a, idem("s", "t", &sent));
        assert_ne!(a, idem("s", "t2", &sent));
        assert_ne!(a, idem("s2", "t", &sent));
        assert_ne!(a, idem("s", "t", &json!([{"rel":"b.py","sha256":"1"}])));
        assert_ne!(a, idem("s", "t", &json!([{"rel":"a.py","sha256":"2"}])));
        assert!(re(r"^[0-9a-f]{64}$").is_match(&a));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_brief_fails_closed() {
        let f = Fixture::new();
        let outside = Fixture::new();
        let target = outside.write("secret.md", "- leaked\n");
        f.write(".intent/placeholder", "");
        std::os::unix::fs::symlink(target, f.root.join(".intent/REQUIREMENTS.md"))
            .expect("symlink brief");
        let error = match build_files(&f, &[file(&f, "pricing.py", "a\nb\nc\n", None)]) {
            Err(e) => e,
            Ok(_) => panic!("symlinked brief accepted"),
        };
        assert!(
            error
                .to_string()
                .contains("requirements could not be validated"),
            "{error}"
        );
    }

    #[test]
    fn turn_snapshot_excludes_later_prompts_and_later_first_prompt() {
        let s = json!({"prompts":["Add discount helpers. The result must never go below zero.","Now rename everything to snake_case"],"prompt_ids":["turn-aaaa","turn-bbbb"],"first_prompt":"Add discount helpers. The result must never go below zero.","first_prompt_id":"turn-aaaa","turn_id":"turn-bbbb"});
        let a = prompts_up_to(&s, "turn-aaaa");
        assert_eq!(
            a["prompts"],
            json!(["Add discount helpers. The result must never go below zero."])
        );
        assert_eq!(a["turn_id"], "turn-aaaa");
        assert_eq!(a["first_prompt"], s["first_prompt"]);
        let mut later = s.clone();
        later["prompts"][0] = json!("ok");
        later["first_prompt_id"] = json!("turn-bbbb");
        assert!(prompts_up_to(&later, "turn-aaaa")["first_prompt"].is_null());
        for turn in ["turn-bbbb", "turn-zzzz", ""] {
            assert_eq!(prompts_up_to(&s, turn)["prompts"], s["prompts"]);
        }
        assert_eq!(prompts_up_to(&s, "")["turn_id"], "turn-bbbb");
    }

    #[test]
    fn codex_transcript_uses_latest_modes_and_requires_explicit_unrestricted_approval() {
        let mut f = Fixture::new();
        f.rt.host = "codex".into();
        let transcript =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/codex/rollout.jsonl");
        let payload = json!({"transcript_path":transcript});
        assert_eq!(
            codex_modes(&payload),
            json!({"approval_policy":"on-request","sandbox":"workspace-write","collaboration_mode":"default"})
        );
        assert_eq!(permission(&f.rt, &payload), "default");
        assert_eq!(host_version(&payload), "0.147.0");
        for (approval, sandbox, mode, want) in [
            ("never", "workspace-write", "default", "bypassPermissions"),
            ("never", "read-only", "default", "default"),
            ("never", "danger-full-access", "plan", "default"),
        ] {
            let path=f.write("rollout.jsonl",&format!("{}\n{}\n",json!({"type":"turn_context","payload":{"approval_policy":"on-request"}}),json!({"type":"turn_context","payload":{"approval_policy":approval,"sandbox_policy":{"type":sandbox},"collaboration_mode":{"mode":mode}}})));
            assert_eq!(permission(&f.rt, &json!({"transcript_path":path})), want);
        }
        assert_eq!(permission(&f.rt, &json!({})), "default");
    }
}
