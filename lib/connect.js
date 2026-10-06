// Connect-link onboarding: POST /v1/connect, show the link, and a detached poller that saves the
// API key once the user approves. The connect request lives in ${CLAUDE_PLUGIN_DATA}/connect.json
// (mode 600: the device code is a secret) and records the service (api_url) it was made for.
//
// Who does what:
// - SessionStart (10 s budget) or a detached `connect-start` child creates the request; the
//   prompt hook (1 s budget) only reads connect.json.
// - One poller (poller_pid) talks to the service. On Claude Code the `connect-wait` Stop hook
//   (asyncRewake) only watches connect.json and wakes the agent the moment the key is saved; it
//   polls itself only if the poller died.
// - Every state change (denied, expired, consumed, revoked, another service) leaves a record
//   whose status explains why the next link is shown (reasonFor).
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { dataDir, ensureDataDir, apiKey, apiUrl, saveApiKey, pluginVersion, osName, BIN, C, disabledReason, legacyKey, promoteLegacyKey, rejectLegacyKey } from "./config.js";
import { readJson, writeJsonAtomic, withLock, isPidAlive, sleep } from "./fsutil.js";
import { startConnect, pollConnect, getMe } from "./api.js";
import { log, errFields } from "./log.js";
import { wellFormed } from "./text.js";
import { withGlobal, loadGlobal } from "./state.js";
import { backedOff, markFailure, clearFailure, CONNECT_BACKOFF_MS, POLL_BACKOFF_MS } from "./backoff.js";

const file = () => path.join(dataDir(), "connect.json");
const lock = () => path.join(dataDir(), "connect.lock");

export function readConnect() {
  const c = readJson(file(), null);
  return c && typeof c === "object" ? c : null;
}

export function updateConnect(fn) {
  ensureDataDir();
  return withLock(lock(), () => {
    const c = readConnect() || {};
    const out = fn(c);
    writeJsonAtomic(file(), c, 0o600);
    return out;
  });
}

// A request made for another service (api_url) is not live here.
export function isLive(c, now = Date.now()) {
  return !!c && c.status === "pending" && typeof c.device_code === "string" && c.expires_at > now + 30000 && (!c.api_url || c.api_url === apiUrl());
}

// What identifies one link: sessions show a link once per token, so a new request shows again.
export const linkToken = (c) => (c && c.created_at ? String(c.created_at) : null);

export function recordError(text) {
  try { withGlobal((g) => { g.last_error = { at: new Date().toISOString(), text: String(text).slice(0, 200) }; }); } catch { /* ignore */ }
}

// One line saying why a new link is needed, from the record being replaced. Null for a first
// connect or a deliberate disconnect.
export function reasonFor(prev, url = apiUrl(), now = Date.now()) {
  if (!prev || typeof prev !== "object" || !prev.status) return null;
  if (prev.api_url && prev.api_url !== url) return `the service changed to ${url}, so this machine needs a new connection.`;
  switch (prev.status) {
    case "denied": return "the last connect request was denied.";
    case "expired": return "the last connect link expired.";
    case "consumed": return "the last connect link was already used.";
    case "revoked": return "your saved key is no longer accepted (revoked or expired).";
    case "save_failed": return "the key from the last connection could not be saved.";
    case "pending": return prev.expires_at <= now + 30000 ? "the last connect link expired." : null;
    case "approved": return "your saved key is no longer available.";
    default: return null;
  }
}

export function spawnDetachedCmd(cmd, extraEnv = {}) {
  try {
    const child = spawn(process.execPath, [BIN, cmd], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...extraEnv } });
    child.unref();
    return child.pid || null;
  } catch {
    return null;
  }
}

// Start the connect-start child unless one was started in the last 15 s (machine-wide).
export function spawnCreator({ host = "claude-code", hostVersion = "unknown" } = {}, now = Date.now()) {
  if (backedOff("connect", CONNECT_BACKOFF_MS, now)) return false;
  const go = withGlobal((g) => {
    if (typeof g.connect_creating_at === "number" && now - g.connect_creating_at < 15000) return false;
    g.connect_creating_at = now;
    return true;
  });
  if (!go) return false;
  return spawnDetachedCmd("connect-start", { INTENT_HOST: host, INTENT_HOST_VERSION: String(hostVersion) }) !== null;
}

// Create a connect request unless one is live. Returns the live record or null.
// timeoutMs: SessionStart has 10 s; the detached child can take its time.
export async function ensureRequest({ host = "claude-code", hostVersion = "unknown", timeoutMs = 5000, force = false } = {}) {
  let c = readConnect();
  if (!force && isLive(c)) {
    ensurePoller(c);
    return c;
  }
  if (!force && backedOff("connect", CONNECT_BACKOFF_MS)) return null;
  const reason = reasonFor(c);
  const r = await startConnect({
    host, host_version: wellFormed(String(hostVersion || "unknown")).slice(0, 40), plugin_version: pluginVersion(),
    os: osName(), machine_name: wellFormed(String(os.hostname() || "")).slice(0, 80) || null,
  }, timeoutMs);
  if (!r.ok) {
    // 429 and 5xx back off for 30 s; a timeout (or a refused connection on a laptop that just woke)
    // is tried again at the next prompt.
    if (r.status === 429 || r.status >= 500 || (r.status === 0 && r.code !== "timeout")) markFailure("connect");
    recordError(`could not start a connect request (${r.status || r.code})`);
    log("connect.start_failed", { code: r.code, status: r.status });
    return null;
  }
  clearFailure("connect");
  c = updateConnect((x) => {
    for (const k of Object.keys(x)) delete x[k];
    Object.assign(x, {
      status: "pending",
      api_url: apiUrl(),
      device_code: r.device_code,
      user_code: r.user_code,
      verification_url: r.verification_url,
      interval_s: Math.max(1, r.interval),
      expires_at: Date.now() + r.expires_in * 1000,
      created_at: Date.now(),
      ...(reason ? { reason } : {}),
    });
    return { ...x };
  });
  log("connect.started", {});
  ensurePoller(c);
  return c;
}

// The detached child behind `connect-start`: create the request for the prompt hook to find.
export async function runCreator() {
  try {
    if (apiKey().key || disabledReason()) return;
    const c = readConnect();
    if (c && c.status === "disconnected" && c.api_url === apiUrl()) return;
    await ensureRequest({ host: process.env.INTENT_HOST === "codex" ? "codex" : "claude-code", hostVersion: process.env.INTENT_HOST_VERSION || "unknown", timeoutMs: 10000 });
  } catch (e) {
    log("error", { cmd: "connect-start", ...errFields(e) });
  } finally {
    try { withGlobal((g) => { delete g.connect_creating_at; }); } catch { /* ignore */ }
  }
}

export function ensurePoller(c = readConnect()) {
  if (!isLive(c) || isPidAlive(c.poller_pid)) return;
  const pid = spawnDetachedCmd("connect-poll");
  updateConnect((x) => { if (!isPidAlive(x.poller_pid)) x.poller_pid = pid; });
}

// Take the poller role unless another live process has it.
function claimPoller(me = process.pid) {
  return updateConnect((x) => {
    if (x.poller_pid === me) return true;
    if (x.poller_pid && isPidAlive(x.poller_pid)) return false;
    x.poller_pid = me;
    return true;
  });
}

// A request that was replaced or finished: the key is only handed out once, so a loser of a
// poll race sees "consumed"; that must not undo the winner's "approved".
function markEnded(status) {
  updateConnect((x) => {
    if (x.status !== "pending") return;
    x.status = status;
    delete x.device_code;
  });
}

// Apply one poll response. Returns "approved" | "pending" | "gone".
function applyPoll(r) {
  if (!r.ok) {
    if (r.status === 404) { markEnded("expired"); return "gone"; }
    return "pending";
  }
  if (r.status === "approved" && r.api_key) {
    // Save the key first. The service hands it out once, so nothing may be acknowledged before it
    // is on disk; if saving fails, say so instead of pretending to be connected.
    try {
      saveApiKey(r.api_key);
    } catch (e) {
      log("connect.save_failed", errFields(e));
      recordError(`could not save the key (${(e && e.code) || "error"})`);
      markEnded("save_failed");
      return "gone";
    }
    updateConnect((x) => { x.status = "approved"; x.announce = true; x.handle = r.handle || null; delete x.device_code; });
    log("connect.approved", {});
    return "approved";
  }
  if (r.status === "pending") return "pending";
  // denied, expired, or consumed (someone else already picked the key up).
  if (apiKey().source === "config") return "approved"; // we lost a race with ourselves; the key is saved
  markEnded(r.status === "approved" ? "save_failed" : r.status);
  return "gone";
}

// One GET, used by the prompt hook as a fallback when the poller died. 1 s budget.
export async function checkConnectOnce(timeoutMs = C.polling.pending_check_timeout_ms) {
  const c = readConnect();
  if (!isLive(c) || backedOff("connect_poll", POLL_BACKOFF_MS)) return "none";
  const r = await pollConnect(c.device_code, timeoutMs);
  if (!r.ok && (!r.status || r.status >= 500)) markFailure("connect_poll");
  return applyPoll(r);
}

// "connected" is announced once, by whichever process sees it first. Returns { handle } or null.
export function takeConnectedAnnouncement() {
  const c = readConnect();
  if (!c || !c.announce) return null;
  return updateConnect((x) => {
    if (!x.announce) return null;
    delete x.announce;
    return { handle: typeof x.handle === "string" ? x.handle : null };
  });
}

export const connectedText = (handle) => (handle ? `Intent Check connected as ${handle}` : "Intent Check connected");

// Poll (when we hold the poller role) and/or watch until the request ends. watch(c) may return
// a value to stop with. Returns that value, or null when the request ended or time ran out.
async function runLoop({ deadline, watch = null, tickMs = null }) {
  let failures = 0;
  let nextPoll = 0;
  while (Date.now() < deadline && failures < 40) {
    const c = readConnect();
    if (watch) { const w = watch(c); if (w) return w; }
    if (!isLive(c)) return null;
    if ((apiKey().key && apiKey().source === "config") || disabledReason()) return null;
    if (claimPoller() && Date.now() >= nextPoll) {
      const interval = Math.max(1000, (c.interval_s || 3) * 1000);
      await sleep(nextPoll ? 0 : interval);
      const fresh = readConnect();
      if (!isLive(fresh)) continue;
      const r = await pollConnect(fresh.device_code, 10000);
      // Service unreachable for a couple of minutes: stop; the next prompt re-checks and restarts us.
      failures = r.ok || r.status ? 0 : failures + 1;
      if (applyPoll(r) !== "pending") continue;
      nextPoll = Date.now() + interval;
    } else {
      await sleep(tickMs || 1000);
    }
  }
  return null;
}

export async function runPoller() {
  if (!claimPoller()) return;
  await runLoop({ deadline: Date.now() + C.polling.connect_expires_s * 1000 + 60000 });
}

// The `connect-wait` Stop hook (Claude Code, asyncRewake). Returns { exit: 2, text, summary } the
// moment the key is saved, otherwise { exit: 0 } without a word: when the request is denied,
// expired, consumed or skipped the next prompt explains.
export async function runWaiter({ skipped = () => false, budgetMs = 870000 } = {}) {
  if (disabledReason()) return { exit: 0 };
  const done = (c) => {
    if (c && c.announce) {
      const a = takeConnectedAnnouncement();
      if (a) return { exit: 2, text: `${connectedText(a.handle)}. Tell the user in one short line that Intent Check is now connected, then carry on with their original request (the connect step is finished).`, summary: connectedText(a.handle) };
    }
    return null;
  };
  const first = readConnect();
  const fast = done(first);
  if (fast) return fast;
  if (apiKey().key || !isLive(first) || skipped()) return { exit: 0 };
  // One waiter per request: later Stop hooks find this one alive and leave.
  const mine = updateConnect((x) => {
    if (x.waiter_pid && x.waiter_pid !== process.pid && isPidAlive(x.waiter_pid)) return false;
    x.waiter_pid = process.pid;
    return true;
  });
  if (!mine) return { exit: 0 };
  const r = await runLoop({
    deadline: Date.now() + budgetMs,
    watch: (c) => done(c) || (skipped() ? { exit: 0 } : null),
  });
  return r || { exit: 0 };
}

// Move a legacy top-level api_key under the current service once /v1/me accepts it. Returns
// "migrated" | "rejected" | "unreachable" | "none".
export async function migrateLegacyKey(timeoutMs = 3000) {
  const k = legacyKey();
  if (!k || process.env.INTENT_API_KEY) return "none";
  if (backedOff("migrate", CONNECT_BACKOFF_MS)) return "unreachable";
  const r = await getMe(k, timeoutMs);
  if (r.ok) {
    clearFailure("migrate");
    promoteLegacyKey();
    log("config.migrated", {});
    return "migrated";
  }
  if (r.status === 401 || r.status === 403 || r.status === 404) {
    rejectLegacyKey();
    markRevoked({ spawn: false });
    return "rejected";
  }
  markFailure("migrate");
  return "unreachable";
}

// The service stopped accepting our saved key (401): forget it and leave a record that explains
// the next link. Starts the creator so the link is ready for the next prompt.
export function markRevoked({ spawn = true } = {}) {
  try {
    const c = readConnect();
    if (!isLive(c)) updateConnect((x) => { for (const k of Object.keys(x)) delete x[k]; Object.assign(x, { status: "revoked", api_url: apiUrl(), at: Date.now() }); });
    if (spawn) spawnCreator();
  } catch (e) {
    log("error", { cmd: "mark-revoked", ...errFields(e) });
  }
}

export function markDisconnected() {
  updateConnect((x) => { for (const k of Object.keys(x)) delete x[k]; Object.assign(x, { status: "disconnected", api_url: apiUrl(), at: Date.now() }); });
}

export const lastError = () => loadGlobal().last_error || null;
