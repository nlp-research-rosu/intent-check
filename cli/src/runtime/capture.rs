use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn run(
    cwd: &Path,
    program: &str,
    args: &[&str],
    envs: &[(&str, String)],
    input: Option<Vec<u8>>,
    timeout: u64,
) -> Result<(bool, String)> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (*k, v)))
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    if let Some(input) = input
        && let Some(mut stdin) = child.stdin.take()
    {
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let stdout = child.stdout.take().context("Missing child stdout")?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut data = Vec::new();
        let _ = stdout.take(256 * 1024 * 1024).read_to_end(&mut data);
        let _ = tx.send(data);
    });
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(5));
    };
    let bytes = rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
    Ok((
        status.is_some_and(|s| s.success()),
        String::from_utf8_lossy(&bytes).into(),
    ))
}
pub(super) fn git_env(
    cwd: &Path,
    args: &[&str],
    envs: &[(&str, String)],
    input: Option<Vec<u8>>,
    timeout: u64,
) -> Option<String> {
    let mut all = vec![
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.quotePath=false",
    ];
    all.extend_from_slice(args);
    let mut vars = vec![
        ("GIT_OPTIONAL_LOCKS", "0".into()),
        ("GIT_TERMINAL_PROMPT", "0".into()),
        ("LC_ALL", "C".into()),
    ];
    vars.extend_from_slice(envs);
    run(cwd, "git", &all, &vars, input, timeout)
        .ok()
        .filter(|(ok, _)| *ok)
        .map(|(_, out)| out)
}
pub(super) fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    git_env(cwd, args, &[], None, 5000)
}
pub(super) fn root(cwd: &Path) -> PathBuf {
    git(cwd, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim()))
        .and_then(|p| p.canonicalize().ok())
        .unwrap_or_else(|| cwd.canonicalize().unwrap_or_else(|_| cwd.into()))
}
pub(super) fn relative(root: &Path, path: &Path) -> Option<String> {
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let full = full.canonicalize().unwrap_or(full);
    let rel = full
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    crate::requirements::relative_path(&rel).ok()?;
    Some(rel)
}
fn mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|s| s.modified().ok())
        .and_then(|s| s.duration_since(UNIX_EPOCH).ok())
        .map(|s| s.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn baseline(rt: &Runtime, cwd: &Path) -> Value {
    let root = root(cwd);
    let head = git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).map(|s| s.trim().to_owned());
    if let Some(head) = head {
        let temp = rt.data.join("tmp").join(format!("index-{}", id()));
        let _ = state::private_dir(temp.parent().expect("Index parent"));
        let vars = vec![
            ("GIT_INDEX_FILE", temp.to_string_lossy().into_owned()),
            ("GIT_AUTHOR_NAME", "intent-check".into()),
            ("GIT_AUTHOR_EMAIL", "intent-check@localhost".into()),
            ("GIT_COMMITTER_NAME", "intent-check".into()),
            ("GIT_COMMITTER_EMAIL", "intent-check@localhost".into()),
        ];
        let sha = (|| -> Option<String> {
            let index = git(&root, &["rev-parse", "--git-path", "index"])?;
            let index = root.join(index.trim());
            if index.exists() {
                fs::copy(index, &temp).ok()?;
            } else {
                git_env(&root, &["read-tree", &head], &vars, None, 3000)?;
            }
            git_env(&root, &["add", "-u"], &vars, None, 5000)?;
            let tree = git_env(&root, &["write-tree"], &vars, None, 3000)?;
            if git(&root, &["rev-parse", &format!("{head}^{{tree}}")])?.trim() == tree.trim() {
                Some(head.clone())
            } else {
                git_env(
                    &root,
                    &[
                        "commit-tree",
                        tree.trim(),
                        "-p",
                        &head,
                        "-m",
                        "intent-check baseline",
                    ],
                    &vars,
                    None,
                    3000,
                )
                .map(|s| s.trim().into())
            }
        })();
        let _ = fs::remove_file(&temp);
        let _ = fs::remove_file(temp.with_extension("lock"));
        let mut untracked = json!({});
        for path in git(&root, &["ls-files", "--others", "--exclude-standard", "-z"])
            .unwrap_or_default()
            .split('\0')
            .filter(|s| !s.is_empty())
            .take(5000)
        {
            untracked[path] = json!(mtime(&root.join(path)));
        }
        return json!({"repo":root,"head":head,"sha":sha,"untracked":untracked,"at":now()});
    }
    let shadow = shadow_tree(rt, &root, true)
        .map(|(dir, tree, _)| json!({"dir":dir,"root":root,"tree":tree,"at":now()}));
    json!({"repo":root,"sha":null,"head":null,"untracked":{},"at":now(),"shadow":shadow})
}

fn shadow_env(dir: &Path, root: &Path, index: &Path) -> Vec<(&'static str, String)> {
    vec![
        ("GIT_DIR", dir.to_string_lossy().into()),
        ("GIT_WORK_TREE", root.to_string_lossy().into()),
        ("GIT_INDEX_FILE", index.to_string_lossy().into()),
        ("GIT_LITERAL_PATHSPECS", "1".into()),
        ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ("GIT_CONFIG_GLOBAL", "/dev/null".into()),
        ("GIT_CONFIG_COUNT", "3".into()),
        ("GIT_CONFIG_KEY_0", "core.autocrlf".into()),
        ("GIT_CONFIG_VALUE_0", "false".into()),
        ("GIT_CONFIG_KEY_1", "core.safecrlf".into()),
        ("GIT_CONFIG_VALUE_1", "false".into()),
        ("GIT_CONFIG_KEY_2", "core.attributesFile".into()),
        ("GIT_CONFIG_VALUE_2", String::new()),
    ]
}
fn shadow_tree(
    rt: &Runtime,
    root: &Path,
    persist: bool,
) -> Option<(PathBuf, String, BTreeSet<String>)> {
    let real = root.canonicalize().ok()?;
    real.parent()?;
    for home in [env::var_os("HOME"), env::var_os("USERPROFILE")]
        .into_iter()
        .flatten()
    {
        if PathBuf::from(home).canonicalize().ok().as_ref() == Some(&real) {
            return None;
        }
    }
    let dir = rt
        .data
        .join("shadow")
        .join(&hash(real.to_string_lossy().as_bytes())[..32]);
    state::private_dir(&dir).ok()?;
    if !dir.join("HEAD").exists() {
        git(&real, &["init", "--bare", "-q", dir.to_str()?])?;
    }
    let deadline = Instant::now() + Duration::from_millis(1500);
    let mut files = BTreeSet::new();
    let mut stack = vec![real.clone()];
    let mut entries = 0;
    while let Some(folder) = stack.pop() {
        if folder != real && folder.join(".git").exists() {
            continue;
        }
        for entry in fs::read_dir(&folder).ok()?.flatten() {
            entries += 1;
            if entries > 200000 || Instant::now() > deadline {
                return None;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type().ok()?;
            if kind.is_dir() {
                if !name.starts_with('.')
                    && !filter::VENDOR.contains(&name.as_str())
                    && ![
                        "target",
                        "out",
                        "coverage",
                        "env",
                        "site-packages",
                        "Pods",
                        "obj",
                        "bin-debug",
                    ]
                    .contains(&name.as_str())
                {
                    stack.push(path);
                }
            } else if kind.is_file() {
                let rel = relative(&real, &path)?;
                if filter::candidate(&rel) && entry.metadata().ok()?.len() <= 1048576 {
                    if files.len() >= 3000 {
                        return None;
                    }
                    files.insert(rel);
                }
            }
        }
    }
    let index = dir.join(format!("index.{}", id()));
    let vars = shadow_env(&dir, &real, &index);
    let result = (|| -> Option<String> {
        let _ = fs::copy(dir.join("index"), &index);
        if !files.is_empty() {
            let list = files.iter().cloned().collect::<Vec<_>>().join("\0") + "\0";
            git_env(
                &real,
                &[
                    "--literal-pathspecs",
                    "add",
                    "-f",
                    "--ignore-errors",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &vars,
                Some(list.into_bytes()),
                if persist { 2000 } else { 20000 },
            )?;
        }
        let have = git_env(&real, &["ls-files", "-z"], &vars, None, 3000)?;
        let stale: Vec<_> = have
            .split('\0')
            .filter(|s| !s.is_empty() && !files.contains(*s))
            .collect();
        if !stale.is_empty() {
            git_env(
                &real,
                &[
                    "rm",
                    "--cached",
                    "-q",
                    "-f",
                    "--ignore-unmatch",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &vars,
                Some((stale.join("\0") + "\0").into_bytes()),
                3000,
            )?;
        }
        let tree = git_env(&real, &["write-tree"], &vars, None, 3000)?
            .trim()
            .to_owned();
        if persist {
            fs::rename(&index, dir.join("index")).ok()?;
        }
        Some(tree)
    })();
    let _ = fs::remove_file(&index);
    let _ = fs::remove_file(index.with_extension("lock"));
    result.map(|tree| (dir, tree, files))
}

#[derive(Clone)]
pub(super) struct FileChange {
    pub rel: String,
    pub abs: PathBuf,
    pub bytes: Vec<u8>,
    pub text: String,
    pub diff: Option<String>,
    pub changed: usize,
    pub worktree: bool,
}
pub(super) struct Changes {
    pub root: PathBuf,
    pub files: Vec<FileChange>,
    pub skipped: Vec<String>,
}
pub(super) fn changed(diff: &str) -> usize {
    let mut hunk = false;
    diff.lines()
        .filter(|line| {
            if line.starts_with("@@") {
                hunk = true;
                false
            } else if line.starts_with("diff --git ") {
                hunk = false;
                false
            } else {
                hunk && (line.starts_with('+') || line.starts_with('-'))
            }
        })
        .count()
}
pub(super) fn new_diff(rel: &str, content: &str) -> String {
    let lines: Vec<_> = content.lines().collect();
    format!(
        "--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n{}\n",
        lines.len(),
        lines
            .iter()
            .map(|s| format!("+{s}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
pub(super) fn read_file(
    root: &Path,
    rel: &str,
    diff: Option<String>,
    worktree: bool,
) -> Option<FileChange> {
    crate::requirements::relative_path(rel).ok()?;
    if redact::never(rel) {
        return None;
    }
    let abs = root.join(rel).canonicalize().ok()?;
    if !abs.starts_with(root) {
        return None;
    }
    let meta = fs::metadata(&abs).ok()?;
    if !meta.is_file() || meta.len() > 1048576 {
        return None;
    }
    let bytes = fs::read(&abs).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let changed = diff
        .as_ref()
        .map(|s| changed(s))
        .unwrap_or_else(|| text.lines().count());
    Some(FileChange {
        rel: rel.into(),
        abs,
        bytes,
        text,
        diff,
        changed,
        worktree,
    })
}
pub(super) fn collect(rt: &Runtime, snap: &Value, cwd: &Path) -> Changes {
    let baseline = &snap["baseline"];
    let root = if let Some(repo) = baseline["repo"].as_str() {
        PathBuf::from(repo)
    } else {
        root(cwd)
    };
    let touched: Vec<_> = array(&snap["touched"])
        .iter()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect();
    let mut candidates = Vec::new();
    let mut elsewhere = Vec::new();
    for path in &touched {
        if let Some(rel) = relative(&root, path).filter(|p| !p.contains(".claude/worktrees/")) {
            if !candidates.contains(&rel) {
                candidates.push(rel);
            }
        } else {
            elsewhere.push(path.clone());
        }
    }
    let sha = string(&baseline["sha"]);
    let mut diffs = BTreeMap::new();
    let mut new = BTreeSet::new();
    let mut base = sha.to_owned();
    let mut git_repo = false;
    if !sha.is_empty() {
        git_repo = true;
        let mut dirty = BTreeSet::new();
        let status = git_env(
            &root,
            &["status", "--porcelain=v1", "-uall", "-z"],
            &[],
            None,
            15000,
        )
        .unwrap_or_default();
        let entries: Vec<_> = status.split('\0').collect();
        let mut i = 0;
        while i < entries.len() {
            let line = entries[i];
            i += 1;
            if line.len() < 4 {
                continue;
            }
            let xy = &line[..2];
            let rel = &line[3..];
            if xy == "??" {
                if number(&baseline["untracked"][rel]) != mtime(&root.join(rel)) {
                    new.insert(rel.into());
                    dirty.insert(rel.into());
                }
            } else if !xy.contains('D') {
                dirty.insert(rel.into());
            }
            if xy.contains('R') || xy.contains('C') {
                i += 1;
            }
        }
        let head = string(&baseline["head"]);
        let current = git(&root, &["rev-parse", "HEAD"]).unwrap_or_default();
        if !head.is_empty()
            && current.trim() != head
            && git(
                &root,
                &["merge-base", "--is-ancestor", head, current.trim()],
            )
            .is_some()
            && let Some(committed) = git(
                &root,
                &["diff", "--name-only", "-z", &format!("{head}..HEAD")],
            )
        {
            dirty.extend(
                committed
                    .split('\0')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        }
        let since = git(&root, &["diff", "--name-only", "-z", sha])
            .map(|s| s.split('\0').map(str::to_owned).collect::<BTreeSet<_>>());
        for rel in dirty {
            if (since.as_ref().is_none_or(|s| s.contains(&rel)) || new.contains(&rel))
                && !candidates.contains(&rel)
            {
                candidates.push(rel);
            }
        }
    } else if let Some(sh) = baseline.get("shadow").filter(|s| s.is_object()) {
        if let Some((dir, tree, _)) = shadow_tree(rt, &root, false) {
            let vars = shadow_env(&dir, &root, &dir.join("index.unused"));
            let before = string(&sh["tree"]);
            if let Some(paths) = git_env(
                &root,
                &[
                    "diff-tree",
                    "-r",
                    "--no-renames",
                    "--name-only",
                    "-z",
                    before,
                    &tree,
                ],
                &vars,
                None,
                15000,
            ) {
                for rel in paths.split('\0').filter(|s| !s.is_empty()) {
                    if !candidates.iter().any(|s| s == rel) {
                        candidates.push(rel.into());
                    }
                }
                for rel in &candidates {
                    if git_env(
                        &root,
                        &["cat-file", "-e", &format!("{before}:{rel}")],
                        &vars,
                        None,
                        3000,
                    )
                    .is_none()
                    {
                        new.insert(rel.clone());
                    } else if let Some(diff) = git_env(
                        &root,
                        &[
                            "diff-tree",
                            "-p",
                            "-r",
                            "--no-renames",
                            "--no-ext-diff",
                            "--no-textconv",
                            "-U3",
                            before,
                            &tree,
                            "--",
                            rel,
                        ],
                        &vars,
                        None,
                        15000,
                    ) {
                        diffs.insert(rel.clone(), diff);
                    }
                }
            }
        }
    } else {
        base = "HEAD".into();
        git_repo = git(&root, &["rev-parse", "--git-dir"]).is_some();
    }
    let mut result = Changes {
        root: root.clone(),
        files: Vec::new(),
        skipped: Vec::new(),
    };
    for rel in candidates {
        if !filter::candidate(&rel) {
            continue;
        }
        if git(&root, &["check-ignore", "--", &rel]).is_some() {
            continue;
        }
        let patch_path = root.join(&rel).to_string_lossy().into_owned();
        let mut diff = diffs.remove(&rel);
        if git_repo && !base.is_empty() {
            if !new.contains(&rel)
                && git(&root, &["cat-file", "-e", &format!("{base}:{rel}")]).is_some()
            {
                diff = git_env(
                    &root,
                    &[
                        "diff",
                        "--no-color",
                        "--no-ext-diff",
                        "--no-textconv",
                        "-U3",
                        &base,
                        "--",
                        &rel,
                    ],
                    &[],
                    None,
                    15000,
                );
            } else {
                new.insert(rel.clone());
            }
        }
        if diff.is_none() && !new.contains(&rel) {
            let patches = &snap["patches"][&patch_path];
            if !array(patches).is_empty() {
                let mut text = format!("--- a/{rel}\n+++ b/{rel}\n");
                for p in array(patches) {
                    text.push_str(&format!(
                        "@@ -{},{} +{},{} @@\n{}\n",
                        number(&p["oldStart"]),
                        number(&p["oldLines"]),
                        number(&p["newStart"]),
                        number(&p["newLines"]),
                        array(&p["lines"])
                            .iter()
                            .map(string)
                            .collect::<Vec<_>>()
                            .join("\n")
                    ));
                }
                diff = Some(text);
            }
        }
        let Some(mut file) = read_file(&root, &rel, diff, false) else {
            continue;
        };
        if new.contains(&rel) {
            file.diff = Some(new_diff(&rel, &file.text));
            file.changed = file.text.lines().count();
        }
        if file.changed == 0 {
            continue;
        }
        if filter::include(&rel, &file.text) {
            result.files.push(file);
        } else if file.changed >= 3 {
            result.skipped.push(rel);
        }
    }
    let common = git(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    for path in elsewhere {
        let Some(parent) = path.parent() else {
            continue;
        };
        let top = self::root(parent);
        if top == root
            || common.is_none()
            || git(
                &top,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            ) != common
        {
            continue;
        }
        let Some(rel) = relative(&top, &path) else {
            continue;
        };
        if result.files.iter().any(|f| f.rel == rel) {
            continue;
        }
        let diff = git(
            &top,
            &["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", &rel],
        );
        if let Some(mut file) = read_file(&top, &rel, diff, true) {
            if git(&top, &["cat-file", "-e", &format!("HEAD:{rel}")]).is_none() {
                file.diff = Some(new_diff(&rel, &file.text));
                file.changed = file.text.lines().count();
            }
            if file.changed >= 1 && filter::include(&rel, &file.text) {
                result.files.push(file);
            }
        }
    }
    result
}
