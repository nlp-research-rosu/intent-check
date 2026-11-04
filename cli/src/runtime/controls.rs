use super::*;

fn settings(rt: &Runtime, disabled: bool, live: Option<bool>) -> Result<()> {
    state::update(&rt.data.join("config.json"), json!({}), |s| {
        if disabled {
            s["disabled"] = json!(true);
        } else {
            state::remove(s, "disabled");
        }
        if let Some(live) = live {
            s["live"] = json!(live);
        }
        Ok(())
    })
}
pub(super) fn command(rt: &Runtime, command: &str) -> Result<String> {
    if command == "off" {
        settings(rt, true, None).context("could not turn checks off. Set INTENT_DISABLED=1 to stop uploads until the local data folder is writable")?;
        return Ok("Intent Prover is off. Nothing will be sent until it is turned back on (intent-prover on or intent-prover live).".into());
    }
    if command == "on" || command == "live" {
        let was_live = rt.live();
        settings(rt, false, Some(command == "live"))
            .context("could not turn checks on; check that the local data folder is writable")?;
        if let Some(reason) = rt.disabled() {
            return Ok(format!(
                "Intent Prover is on, but {reason}=1 is set in the environment, so nothing will be sent until it is removed."
            ));
        }
        let mut text = format!(
            "Intent Prover is on{}. {}{}",
            if rt.live() { " (live)" } else { "" },
            if rt.live() {
                "Every edit is checked as it happens, and each turn at its end."
            } else {
                "Changes are checked at the end of each turn."
            },
            if was_live && !rt.live() {
                " Reviews after edits are now off; intent-prover live turns them back on."
            } else {
                ""
            }
        );
        if let Ok(value) = env::var("INTENT_LIVE")
            && ["0", "1"].contains(&value.as_str())
            && (value == "1") != (command == "live")
        {
            text.push_str(&format!(
                "\nINTENT_LIVE={value} is set in the environment and takes precedence."
            ));
        }
        if rt.key()?.is_none() {
            text.push_str("\nIntent Prover is not connected. Run intent-prover login. Nothing is checked until setup is complete.");
        }
        return Ok(text);
    }
    anyhow::ensure!(command == "doctor", "Unknown runtime control");
    let mut key = rt.key();
    let mut tasks = Vec::new();
    let mut account = "none";
    let mut healthy = false;
    if key.as_ref().is_ok_and(|k| k.is_some()) {
        let api = protocol::Api::new(rt)?;
        let reply = api.request("GET", "/tasks?limit=1", None, None, 3000);
        if reply.status == 200 {
            account = "key accepted";
            healthy = true;
        } else if reply.status == 401 {
            account = "the service did not accept the key";
            if env::var("INTENT_API_KEY").is_ok() {
                tasks.push("The key in INTENT_API_KEY is not accepted. Set a valid one, or unset it and run intent-prover login.".into());
            } else {
                crate::auth::clear_key(
                    &rt.config.server_url,
                    key.as_ref().ok().and_then(|k| k.as_deref()).unwrap_or(""),
                )?;
                key = rt.key();
            }
        } else {
            account = "could not reach the service";
            tasks.push(format!("The service at {} could not be reached. Check your network and run intent-prover doctor again.",rt.config.server_url));
        }
    }
    if let Err(error) = &key {
        tasks.push(format!("Credential problem: {error}"));
    }
    let key = key.unwrap_or(None);
    let paused = key.as_ref().and_then(|key| rt.paused(key));
    if healthy && paused.as_ref().is_some_and(|p| p["code"] != 426) {
        rt.global_mut(|g| {
            state::remove(g, "paused");
            Ok(())
        })?;
    }
    let global = rt.global();
    let reason = rt.disabled();
    let source = key
        .as_ref()
        .map(|key| {
            format!(
                "{}, ending {}",
                if env::var("INTENT_API_KEY").is_ok() {
                    "INTENT_API_KEY (environment)".into()
                } else {
                    crate::config::directory()
                        .map(|d| d.join("credentials.json").display().to_string())
                        .unwrap_or_else(|_| "credentials file".into())
                },
                key.chars()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<String>()
            )
        })
        .unwrap_or_else(|| "none".into());
    let mut lines = vec![
        format!(
            "Intent Prover v{}: {}",
            rt.version,
            if reason.is_some() {
                "off"
            } else if rt.live() {
                "on (live)"
            } else {
                "on"
            }
        ),
        format!("Service: {}", rt.config.server_url),
        format!("Account: {account}"),
        format!(
            "State: {}{}",
            if key.is_some() {
                "connected"
            } else {
                "not connected"
            },
            if paused.is_some() && (!healthy || paused.as_ref().is_some_and(|p| p["code"] == 426)) {
                " (checks paused)"
            } else {
                ""
            }
        ),
        format!("Key source: {source}"),
        format!(
            "Last check: {}",
            if global["last_check"].is_object() {
                format!(
                    "{}, {}",
                    string(&global["last_check"]["at"]),
                    if global["last_check"]["ok"] == true {
                        "sent"
                    } else {
                        "failed"
                    }
                )
            } else {
                "none yet".into()
            }
        ),
        format!(
            "Last error: {}",
            global["last_error"]["text"].as_str().unwrap_or("none")
        ),
        format!("Local state: {}", rt.data.display()),
    ];
    if reason.is_none() {
        lines.push(host_update(rt)?);
    }
    if let Some(reason) = reason {
        tasks.push(if reason == "off" {
            "Checks are off. Run intent-prover on (or intent-prover live) to turn them on.".into()
        } else {
            format!("{reason}=1 is set in the environment. Remove it to turn checks on.")
        });
    }
    if key.is_none() && reason.is_none() {
        tasks.push("This machine is not connected. Run intent-prover login.".into());
    }
    if global["last_check"].is_null() {
        lines.push(
            "Nothing has been checked yet; checks run after turns that change source files.".into(),
        );
    }
    for task in &tasks {
        lines.push(format!("To do: {task}"));
    }
    if tasks.is_empty() && global["last_check"].is_object() {
        lines.push("Everything is working.".into());
    }
    Ok(lines.join("\n"))
}
fn newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| {
        s.split(['.', '-'])
            .take(3)
            .map(|s| s.parse::<u32>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    parse(a) > parse(b)
}
fn available(rt: &Runtime, market: &Path, plugin: &str) -> Option<String> {
    let mut versions = Vec::new();
    let local = state::read(&market.join(".claude-plugin/marketplace.json"));
    for item in array(&local["plugins"]) {
        if item["name"] == plugin && re(r"^\d+\.\d+\.\d+$").is_match(string(&item["version"])) {
            versions.push(string(&item["version"]).to_owned());
        }
    }
    if market.exists()
        && let Some(tags) = capture::git_env(
            market,
            &["ls-remote", "--tags", "origin", "v*"],
            &[("GCM_INTERACTIVE", "never".into())],
            None,
            8000,
        )
    {
        for c in re(r"(?m)refs/tags/v(\d+\.\d+\.\d+)$").captures_iter(&tags) {
            versions.push(c[1].into());
        }
    }
    versions
        .into_iter()
        .filter(|v| newer(v, &rt.version))
        .max_by(|a, b| {
            if newer(a, b) {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        })
}
fn host_update(rt: &Runtime) -> Result<String> {
    let Some(root) = &rt.root else {
        return Ok("Update: skipped (plugin root is unavailable).".into());
    };
    if state::data_from_root(root).is_none() {
        return Ok("Update: skipped (this copy does not run from the plugin cache).".into());
    }
    if rt.host == "codex" {
        return Ok(
            "Update: not checked on Codex. Update the plugin from Codex's plugin list.".into(),
        );
    }
    let plugin = root.parent().context("Plugin cache")?;
    let market = plugin.parent().context("Marketplace cache")?;
    let cache = market.parent().context("Plugin cache")?;
    let plugin_name = plugin.file_name().unwrap_or_default().to_string_lossy();
    let market_name = market.file_name().unwrap_or_default().to_string_lossy();
    let dir = cache
        .parent()
        .context("Plugins directory")?
        .join("marketplaces")
        .join(market_name.as_ref());
    let manual = "open /plugin, update the marketplace under Marketplaces, then choose Update now for intent under Installed.";
    if !re(r"^[\w.-]+$").is_match(&plugin_name) || !re(r"^[\w.-]+$").is_match(&market_name) {
        return Ok(format!(
            "Update: could not check. To update by hand, {manual}"
        ));
    }
    let cwd = env::current_dir()?;
    let run = |args: &[&str]| {
        capture::run(&cwd, "claude", args, &[], None, 40000).is_ok_and(|(ok, _)| ok)
    };
    let success = run(&["plugin", "marketplace", "update", &market_name])
        && run(&["plugin", "update", &format!("{plugin_name}@{market_name}")]);
    if !success {
        let version = available(rt, &dir, &plugin_name);
        return Ok(format!(
            "Update: {} (the claude command is not available or failed). To update by hand, {manual}",
            version
                .map(|v| format!("v{v} is available, but it could not be installed from here"))
                .unwrap_or_else(|| "could not check from here".into())
        ));
    }
    let best = fs::read_dir(plugin)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|v| re(r"^\d+\.\d+\.\d+").is_match(v))
        .max_by(|a, b| {
            if newer(a, b) {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        });
    if let Some(best) = best.filter(|v| newer(v, &rt.version)) {
        return Ok(format!(
            "Update: v{best} is installed. Run /reload-plugins (or restart Claude Code) to start using it."
        ));
    }
    Ok(available(rt, &dir, &plugin_name)
        .map(|v| {
            format!("Update: v{v} is available but was not installed. To update by hand, {manual}")
        })
        .unwrap_or_else(|| "Update: up to date.".into()))
}
