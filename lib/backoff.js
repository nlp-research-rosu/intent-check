// Machine-wide backoff after failures (a 429, a 5xx, an unreachable service), so a struggling
// service costs one slow attempt, not one per prompt. A plain timeout is not backed off: the next
// prompt tries again. Stored in global.json.
import { loadGlobal, withGlobal } from "./state.js";

export const CONNECT_BACKOFF_MS = 30 * 1000;
export const POLL_BACKOFF_MS = 2 * 60 * 1000;

export function backedOff(name, ms, now = Date.now()) {
  const b = loadGlobal().backoff;
  const t = b && typeof b[name] === "number" ? b[name] : 0;
  return now - t < ms;
}

export function markFailure(name) {
  try { withGlobal((g) => { g.backoff = { ...(g.backoff || {}), [name]: Date.now() }; }); } catch { /* ignore */ }
}

export function clearFailure(name) {
  const b = loadGlobal().backoff;
  if (!b || !b[name]) return;
  try { withGlobal((g) => { if (g.backoff) delete g.backoff[name]; }); } catch { /* ignore */ }
}

// Network-level failure (no answer, timeout, 5xx), as opposed to a real answer from the service.
export const isNetworkFailure = (r) => !r.ok && (!r.status || r.status >= 500);
