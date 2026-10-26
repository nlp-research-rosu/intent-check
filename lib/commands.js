// /intent:on, /intent:live, /intent:off and /intent:doctor (and the Codex skill's equivalents).
// Output is shown to the user by the slash command.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { setDisabled, disabledReason, apiKey, apiUrl, dataDir, pluginVersion, clearSavedApiKey, credentialsFile, credentialsProblem, liveMode, envLive, setLive, installInfo } from "./config.js";
import { checkKey } from "./api.js";
import { loadGlobal, withGlobal } from "./state.js";
import { pausedFor } from "./pause.js";

// Where the key comes from and its last 4 characters; never more of it.
function keySourceText(k) {
  if (!k.key) return "none";
  return `${k.source === "env" ? "INTENT_API_KEY (environment)" : credentialsFile()}, ending ${k.key.slice(-4)}`;
}

// Why nothing is being sent, in one line; null when uploads are expected to happen.
export function whyNothingSent({ reason, k, paused, last }) {
  if (reason) return `checks are off (${reason === "off" ? "/intent:off" : `${reason}=1`}).`;
  if (!k.key) return "this machine is not connected to an account yet.";
  if (paused) return paused.code === 426 ? "this plugin version is too old for the service." : "the service did not accept the API key.";
  if (!last) return "no turn has changed source files since the plugin was installed (checks run after such a turn).";
  return null;
}

export const SETUP_REQUIRED = "Intent Check is not connected. Use the onboarding skill to install the global CLI and run intent-check login. Nothing is checked until setup is complete.";

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
    lines.push(`INTENT_LIVE=${process.env.INTENT_LIVE} is set in the environment and takes precedence.`);
  }
  if (!apiKey().key) lines.push(SETUP_REQUIRED);
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
    const me = await checkKey(k.key, 3000);
    if (me.ok) {
      healthy = true;
      account = "key accepted";
    } else if (me.status === 401) {
      account = "the service did not accept the key";
      if (k.source === "env") todo.push("The key in INTENT_API_KEY is not accepted. Set a valid one, or unset it and run intent-check login.");
      else {
        // A saved key the service no longer knows: forget it, then ask for explicit sign-in.
        clearSavedApiKey(k.key);
        k = apiKey();
      }
    } else {
      account = "could not reach the service";
      todo.push(`The service at ${apiUrl()} could not be reached. Check your network and run /intent:doctor again.`);
    }
  }
  const problem = k.key ? null : credentialsProblem();
  if (problem) todo.push(`${credentialsFile()}: ${problem}.`);
  const paused = k.key ? pausedFor(k.key) : null;
  if (healthy && paused && paused.code !== 426) {
    // The key works again: lift the pause a past rejection left behind.
    withGlobal((g) => { delete g.paused; });
  }
  const gl = loadGlobal();
  const last = gl.last_check && typeof gl.last_check === "object" ? gl.last_check : null;
  const err = gl.last_error || null;

  if (!k.key && !reason) {
    todo.push(SETUP_REQUIRED);
  }
  const state = k.key ? "connected" : "not connected";
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
  for (const t of todo) lines.push(`To do: ${t}`);
  if (!todo.length && !why) lines.push("Everything is working.");
  return lines.join("\n");
}
