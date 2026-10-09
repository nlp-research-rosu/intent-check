// /intent:off, /intent:on, /intent:status, /intent:connect and /intent:disconnect (and the Codex
// skill's equivalents). Output is shown to the user by the slash command.
import { setDisabled, disabledReason, apiKey, apiUrl, dataDir, pluginVersion, clearSavedApiKey, legacyKey, hostVersion, mode, envMode, setMode, MODES } from "./config.js";
import { readConnect, ensureRequest, markDisconnected, updateConnect, isLive, lastError } from "./connect.js";
import { getMe, deleteMyKey } from "./api.js";
import { loadGlobal } from "./state.js";
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

function stateText(k, c) {
  if (k.key) return "connected";
  if (c && c.status === "disconnected" && c.api_url === apiUrl()) return "disconnected (run /intent:connect to connect again)";
  if (isLive(c)) return `waiting for approval at ${c.verification_url}`;
  return "not connected";
}

// Why nothing is being sent, in one line; null when uploads are expected to happen.
export function whyNothingSent({ reason, k, c, paused, last }) {
  if (reason) return `checks are off (${reason === "off" ? "/intent:off" : `${reason}=1`}).`;
  if (!k.key) return c && c.status === "disconnected" ? "you disconnected this machine." : "this machine is not connected to an account yet.";
  if (paused) return paused.code === 426 ? "this plugin version is too old for the service." : "the service did not accept the API key.";
  if (!last) return "no turn has changed source files since the plugin was installed (checks run after such a turn).";
  return null;
}

export async function statusCommand() {
  const reason = disabledReason();
  const k = apiKey();
  const c = readConnect();
  const gl = loadGlobal();
  const paused = k.key ? pausedFor(k.key) : null;
  let account = "none";
  if (k.key) {
    const me = await getMe(k.key, 3000);
    if (me.ok) account = `${me.me.handle}${me.me.key_last4 ? ` (key ending ${me.me.key_last4})` : ""}`;
    else if (me.status === 401) account = "the service did not accept the key";
    else account = "could not reach the service";
  }
  const last = gl.last_check && typeof gl.last_check === "object" ? gl.last_check : null;
  const err = lastError();
  const why = whyNothingSent({ reason, k, c, paused, last });
  const lines = [
    `Intent Check v${pluginVersion()}: ${reason ? `off (${reason})` : "on"}`,
    `Service: ${apiUrl()}`,
    `Account: ${account}`,
    `State: ${stateText(k, c)}${paused ? " (checks paused)" : ""}`,
    `Key source: ${keySourceText(k)}`,
    `Last check: ${last ? `${last.at}, ${last.ok ? "sent" : "failed"}` : "none yet"}`,
    `Last error: ${err ? `${err.text} (${err.at})` : "none"}`,
  ];
  if (why) lines.push(`Nothing is being sent because ${why}`);
  lines.push(`Mode: ${mode()}`);
  if (envMode() && !MODES.includes(envMode())) lines.push(`INTENT_MODE=${process.env.INTENT_MODE} ignored (use classic or per-edit)`);
  lines.push(`Local state: ${dataDir()}`);
  return lines.join("\n");
}

export async function connectCommand() {
  const reason = disabledReason();
  if (reason) return `Intent Check is off (${reason}), so there is nothing to connect. Turn it on first.`;
  const k = apiKey();
  if (k.key) {
    if (k.source === "env") return "Intent Check is connected through INTENT_API_KEY. Unset it to connect with a link.";
    return "Intent Check is already connected. Run /intent:disconnect first to connect another account.";
  }
  const c = await ensureRequest({ host: process.env.INTENT_HOST === "codex" ? "codex" : "claude-code", hostVersion: hostVersion(), timeoutMs: 8000, force: true });
  if (!c) return "Intent Check could not reach the service to make a connect link. Try again in a moment.";
  // The command shows the link itself; the next prompt must not show it a second time.
  updateConnect((x) => { x.cmd_shown = true; });
  return [`Intent Check: connect your account → ${c.verification_url}`, "Open the link and approve it. Intent Check confirms here once it is approved."].join("\n");
}

export async function disconnectCommand() {
  const k = apiKey();
  if (k.source === "env") return "The key comes from INTENT_API_KEY, which Intent Check cannot remove. Unset it in the environment.";
  if (!k.key) {
    markDisconnected();
    return "Intent Check was not connected. Run /intent:connect to connect.";
  }
  const r = await deleteMyKey(k.key, 5000);
  clearSavedApiKey(k.key);
  markDisconnected();
  if (r.ok) return "Intent Check is disconnected: the key was revoked and removed from this machine. Run /intent:connect to connect again.";
  return "Intent Check forgot the key on this machine, but could not reach the service to revoke it. Revoke it from your account page if you want it gone there too.";
}

export function command(cmd, arg = "") {
  if (cmd === "off") {
    setDisabled(true);
    return "Intent Check is off. Nothing will be sent until it is turned back on (/intent:on in Claude Code, intent on in Codex).";
  }
  if (cmd === "mode") {
    if (MODES.includes(arg)) setMode(arg);
    else if (arg) return "Usage: /intent:mode classic|per-edit";
    const line = mode() === "per-edit"
      ? "Mode: per-edit. Every edit is checked as it happens."
      : "Mode: classic. Changes are checked at the end of each turn.";
    return MODES.includes(envMode()) ? `${line} (INTENT_MODE=${process.env.INTENT_MODE} is set in the environment and takes precedence.)` : line;
  }
  const env = (setDisabled(false), disabledReason());
  if (env) return `Intent Check is on, but ${env}=1 is set in the environment, so nothing will be sent until it is removed.`;
  return apiKey().key ? "Intent Check is on." : "Intent Check is on. It will show a link to connect your account at your next prompt.";
}
