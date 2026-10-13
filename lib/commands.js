// /intent:on, /intent:live, /intent:off and /intent:doctor (and the Codex skill's equivalents).
// Output is shown to the user by the slash command.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { setDisabled, disabledReason, apiKey, apiUrl, dataDir, pluginVersion, clearSavedApiKey, legacyKey, hostVersion, liveMode, envLive, setLive, installInfo } from "./config.js";
import { readConnect, ensureRequest, updateConnect, isLive, lastError, markRevoked } from "./connect.js";
import { getMe } from "./api.js";
import { loadGlobal, withGlobal } from "./state.js";
import { pausedFor } from "./pause.js";

const KEY_SOURCE = {
  env: "INTENT_API_KEY (environment)",
  config: "saved by Intent Check for this service",
};

function keySourceText(k) {
  if (!k.key) return "none";
  if (k.source === "env") return KEY_SOURCE.env;
  return legacyKey() === k.key ? "saved by an older version, not yet verified for this service" : KEY_SOURCE.config;
}

// Why nothing is being sent, in one line; null when uploads are expected to happen.
export function whyNothingSent({ reason, k, paused, last }) {
  if (reason) return `checks are off (${reason === "off" ? "/intent:off" : `${reason}=1`}).`;
  if (!k.key) return "this machine is not connected to an account yet.";
  if (paused) return paused.code === 426 ? "this plugin version is too old for the service." : "the service did not accept the API key.";
  if (!last) return "no turn has changed source files since the plugin was installed (checks run after such a turn).";
  return null;
}

// A fresh connect link, as the lines to show. The next prompt must not show it a second time.
export async function connectLink(host = "claude-code") {
  const c = await ensureRequest({ host, hostVersion: hostVersion(), timeoutMs: 8000, force: true });
  if (!c) return null;
  updateConnect((x) => { x.cmd_shown = true; });
  return [`Intent Check: connect your account → ${c.verification_url}`, "Open the link and approve it. Intent Check confirms here once it is approved."].join("\n");
}

const liveLine = () => (liveMode() ? "Every edit is checked as it happens, and each turn at its end." : "Changes are checked at the end of each turn.");

// off: nothing is sent. on: end-of-turn review. live: on, plus a review of every edit.
export async function command(cmd, { host = "claude-code" } = {}) {
  if (cmd === "off") {
    setDisabled(true);
    return "Intent Check is off. Nothing will be sent until it is turned back on (/intent:on or /intent:live).";
  }
  const live = cmd === "live";
  const wasLive = liveMode();
  setDisabled(false);
  setLive(live);
  const env = disabledReason();
  if (env) return `Intent Check is on, but ${env}=1 is set in the environment, so nothing will be sent until it is removed.`;
  const lines = [`Intent Check is on${live ? " (live)" : ""}. ${liveLine()}${wasLive && !liveMode() ? " Live review is now off; /intent:live turns it back on." : ""}`];
  if (envLive() !== null && envLive() !== live) {
    const name = (process.env.INTENT_LIVE || "").trim() ? "INTENT_LIVE" : "INTENT_MODE";
    lines.push(`${name}=${process.env[name]} is set in the environment and takes precedence.`);
  }
  if (!apiKey().key) lines.push((await connectLink(host)) || "It is not connected yet, and the service could not be reached to make a connect link. Run /intent:doctor in a moment.");
  return lines.join("\n");
}

const run = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell: process.platform === "win32" }, (err) => resolve(!err));
});

const newer = (a, b) => {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

const MANUAL_UPDATE = "open /plugin, update the marketplace under Marketplaces, then choose Update now for intent under Installed.";

// The release tags (vX.Y.Z) of the marketplace's remote, read through the host's clone of it.
// Read-only: nothing in the clone changes. Empty when git or the network is not available.
const remoteTags = (dir) => new Promise((resolve) => {
  execFile("git", ["-C", dir, "ls-remote", "--tags", "origin", "v*"], { timeout: 8000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } }, (err, out) => resolve(err ? "" : String(out)));
});

// The newest released version, when it is newer than this copy; otherwise null. Two sources: the
// host's local copy of the marketplace (<home>/plugins/marketplaces/<marketplace>), which is only
// as fresh as its last marketplace update, and the release tags of that copy's remote.
export async function availableVersion(info = installInfo(), tags = remoteTags) {
  if (!info) return null;
  const dir = path.join(info.versionsDir, "..", "..", "..", "marketplaces", info.marketplace);
  const found = [];
  try {
    const entry = (JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), "utf8")).plugins || []).find((p) => p && p.name === info.plugin);
    if (entry && typeof entry.version === "string" && /^\d+\.\d+\.\d+$/.test(entry.version)) found.push(entry.version);
  } catch { /* no local copy */ }
  if (fs.existsSync(dir)) for (const m of (await tags(dir)).matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)$/gm)) found.push(m[1]);
  const best = found.sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  return best && newer(best, info.version) ? best : null;
}

// Ask the host to update the plugin. Returns the one line to show. Claude Code only: its CLI
// has `plugin marketplace update` and `plugin update`; a running session keeps the old version
// until it reloads its plugins.
export async function hostUpdate({ host = "claude-code", info = installInfo(), exec = run, available = availableVersion } = {}) {
  if (!info) return "Update: skipped (this copy does not run from the plugin cache).";
  if (host === "codex") return "Update: not checked on Codex. Update the plugin from Codex's plugin list.";
  if (!/^[\w.-]+$/.test(info.marketplace) || !/^[\w.-]+$/.test(info.plugin)) return `Update: could not check. To update by hand, ${MANUAL_UPDATE}`;
  const ok = (await exec("claude", ["plugin", "marketplace", "update", info.marketplace], 40000))
    && (await exec("claude", ["plugin", "update", `${info.plugin}@${info.marketplace}`], 40000));
  if (!ok) {
    const v = await available(info);
    return `Update: ${v ? `v${v} is available, but it could not be installed from here` : "could not check from here"} (the claude command is not available or failed). To update by hand, ${MANUAL_UPDATE}`;
  }
  let versions = [];
  try { versions = fs.readdirSync(info.versionsDir); } catch { /* no cache folder */ }
  const best = versions.filter((v) => /^\d+\.\d+\.\d+/.test(v)).sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  if (best && newer(best, info.version)) return `Update: v${best} is installed. Run /reload-plugins (or restart Claude Code) to start using it.`;
  const v = await available(info);
  return v ? `Update: v${v} is available but was not installed. To update by hand, ${MANUAL_UPDATE}` : "Update: up to date.";
}

// /intent:doctor: say what state the plugin is in, repair what can be repaired from here
// (a missing or rejected connection, an out-of-date plugin), and name what only the user can do.
export async function doctorCommand({ host = "claude-code", update = hostUpdate, available = availableVersion } = {}) {
  const reason = disabledReason();
  let k = apiKey();
  const todo = [];
  let account = "none";
  let healthy = false;
  if (k.key) {
    const me = await getMe(k.key, 3000);
    if (me.ok) {
      healthy = true;
      account = `${me.me.handle}${me.me.key_last4 ? ` (key ending ${me.me.key_last4})` : ""}`;
    } else if (me.status === 401) {
      account = "the service did not accept the key";
      if (k.source === "env") todo.push("The key in INTENT_API_KEY is not accepted. Set a valid one, or unset it to connect with a link.");
      else {
        // A saved key the service no longer knows: forget it, so a new link can replace it.
        clearSavedApiKey(k.key);
        markRevoked({ spawn: false });
        k = apiKey();
      }
    } else {
      account = "could not reach the service";
      todo.push(`The service at ${apiUrl()} could not be reached. Check your network and run /intent:doctor again.`);
    }
  }
  const paused = k.key ? pausedFor(k.key) : null;
  if (healthy && paused && paused.code !== 426) {
    // The key works again: lift the pause a past rejection left behind.
    withGlobal((g) => { delete g.paused; });
  }
  const gl = loadGlobal();
  const last = gl.last_check && typeof gl.last_check === "object" ? gl.last_check : null;
  const err = lastError();

  let link = null;
  if (!k.key && !reason) {
    // A broken data folder must not hide the rest of the report.
    try { link = await connectLink(host); } catch { link = null; }
    if (!link) todo.push("Not connected, and a connect link could not be made. Run /intent:doctor again in a moment.");
  }
  const c = readConnect();
  const state = k.key ? "connected" : isLive(c) ? `waiting for approval at ${c.verification_url}` : "not connected";
  const stillPaused = paused && (paused.code === 426 || !healthy);
  const why = whyNothingSent({ reason, k, paused: stillPaused ? paused : null, last });
  // The update runs first: it refreshes the host's copy of the marketplace that `available` reads.
  // It is skipped while checks are off. The newest version is looked up once and shared.
  let latest;
  let looked = false;
  const lookup = async () => { if (!looked) { looked = true; latest = await available(); } return latest; };
  const updateLine = reason ? null : await update({ host, available: lookup });
  await lookup();
  const lines = [
    `Intent Check v${pluginVersion()}${latest ? ` (v${latest} available)` : ""}: ${reason === "off" ? "off" : reason ? `off (${reason}=1)` : liveMode() ? "on (live)" : "on"}`,
    `Service: ${apiUrl()}`,
    `Account: ${account}`,
    `State: ${state}${stillPaused ? " (checks paused)" : ""}`,
    `Key source: ${keySourceText(k)}`,
    `Last check: ${last ? `${last.at}, ${last.ok ? "sent" : "failed"}` : "none yet"}`,
    `Last error: ${err ? `${err.text} (${err.at})` : "none"}`,
    `Local state: ${dataDir()}`,
  ];
  if (process.env.INTENT_LIVE && envLive() === null) lines.push(`INTENT_LIVE=${process.env.INTENT_LIVE} ignored (use 1 or 0)`);
  if (updateLine) lines.push(updateLine);
  if (why) lines.push(`Nothing is being sent because ${why}`);
  if (reason === "off") todo.push("Checks are off. Run /intent:on (or /intent:live) to turn them on.");
  else if (reason) todo.push(`${reason}=1 is set in the environment. Remove it to turn checks on.`);
  if (link) lines.push(link);
  for (const t of todo) lines.push(`To do: ${t}`);
  if (!todo.length && !link && !why) lines.push("Everything is working.");
  return lines.join("\n");
}
