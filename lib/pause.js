// Pausing uploads after the service rejected the key (401) or the plugin version (426).
import { apiKey, pluginVersion } from "./config.js";
import { loadGlobal, withGlobal } from "./state.js";
import { sha256 } from "./fsutil.js";

// After a 401 or 426 the same key (and plugin version) would only be rejected again, so uploads
// pause until the key or the plugin version changes.
const pauseId = (key) => sha256(`${key}\n${pluginVersion()}`).slice(0, 16);

const ENV_PAUSE_MS = 24 * 3600 * 1000;

// A saved key that was rejected is deleted (connect starts again); an env-var key cannot be, so
// its pause expires after a day in case the service recovers or the account is fixed.
export function pausedFor(key, now = Date.now()) {
  const p = loadGlobal().paused;
  if (!p || p.id !== pauseId(key)) return null;
  if (p.source === "env" && now - Date.parse(p.at) > ENV_PAUSE_MS) return null;
  return p;
}

export const isPaused = (key) => !!pausedFor(key);

export function pause(key, code) {
  const source = apiKey().source;
  try { withGlobal((g) => { g.paused = { id: pauseId(key), code, source, at: new Date().toISOString() }; }); } catch { /* ignore */ }
}

export const pausedNote = (p) => (p.code === 426
  ? "Intent Check: checks are paused because this plugin version is too old for the service. Update the intent plugin to resume."
  : "Intent Check: checks are paused because the API key was not accepted.");

