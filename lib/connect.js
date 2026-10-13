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
// connect.
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

// A pid alone is not proof (pids are reused): the holder of the poller/waiter role refreshes
// <role>_at on every loop tick, and a heartbeat older than ~3 intervals (at least 15 s) means dead.
export function holderAlive(c, role, now = Date.now()) {
  if (!c || !isPidAlive(c[`${role}_pid`])) return false;
  const at = c[`${role}_at`];
  if (typeof at !== "number") return false;
  return now - at < Math.max(15000, 3 * Math.max(1000, (c.interval_s || 3) * 1000));
}
export const pollerAlive = (c) => holderAlive(c, "poller");

export function spawnDetachedCmd(cmd, extraEnv = {}) {
  try {
    const child = spawn(process.execPath, [BIN, cmd], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...extraEnv } });
    child.unref();
    return child.pid || null;
  } catch {
    return null;
  }
}

// One process creates a connect request at a time (machine-wide claim, 15 s). The claim is the
// timestamp it was taken at; only its owner may release it.
const CLAIM_MS = 15000;
function takeClaim(now = Date.now()) {
  return withGlobal((g) => {
    if (typeof g.connect_creating_at === "number" && now - g.connect_creating_at < CLAIM_MS) return null;
    g.connect_creating_at = now;
    return now;
  });
}
function releaseClaim(stamp) {
  if (!stamp) return;
  try { withGlobal((g) => { if (g.connect_creating_at === stamp) delete g.connect_creating_at; }); } catch { /* ignore */ }
}
const claimHeld = () => { const t = loadGlobal().connect_creating_at; return typeof t === "number" && Date.now() - t < CLAIM_MS; };

// Start the connect-start child unless one was started in the last 15 s (machine-wide). The child
// gets the claim through INTENT_CLAIM.
export function spawnCreator({ host = "claude-code", hostVersion = "unknown" } = {}, now = Date.now()) {
  if (backedOff("connect", CONNECT_BACKOFF_MS, now)) return false;
  const stamp = takeClaim(now);
  if (!stamp) return false;
  const pid = spawnDetachedCmd("connect-start", { INTENT_HOST: host, INTENT_HOST_VERSION: String(hostVersion), INTENT_CLAIM: String(stamp) });
  if (pid === null) releaseClaim(stamp);
  return pid !== null;
}

// Why creating the last request failed (shown once per session).
export function connectFailure() {
  const f = loadGlobal().connect_fail;
  return f && typeof f.at === "number" && Date.now() - f.at < 10 * 60 * 1000 ? f : null;
}

// Create a connect request unless one is live. Returns the live record or null.
// timeoutMs: SessionStart has 10 s; the detached child can take its time.
// claim: the creation claim the caller already holds (the detached child); otherwise one is taken
// here, and a caller that finds another creator at work waits for its record instead of making a second.
export async function ensureRequest({ host = "claude-code", hostVersion = "unknown", timeoutMs = 5000, force = false, claim = null } = {}) {
  let c = readConnect();
  if (!force && isLive(c)) {
    ensurePoller(c);
    return c;
  }
  if (!force && backedOff("connect", CONNECT_BACKOFF_MS)) return null;
  let mine = null;
  if (!claim && !force) {
    mine = takeClaim();
    if (!mine) {
      const end = Date.now() + Math.min(timeoutMs, 5000);
      while (Date.now() < end && claimHeld()) {
        await sleep(100);
        if (isLive(readConnect())) break;
      }
      c = readConnect();
      if (isLive(c)) { ensurePoller(c); return c; }
      return null;
    }
  }
  try {
    return await createRequest({ host, hostVersion, timeoutMs, force, prev: c });
  } finally {
    releaseClaim(mine);
  }
}

async function createRequest({ host, hostVersion, timeoutMs, force, prev }) {
  const reason = reasonFor(prev);
  const r = await startConnect({
    host, host_version: wellFormed(String(hostVersion || "unknown")).slice(0, 40), plugin_version: pluginVersion(),
    os: osName(), machine_name: wellFormed(String(os.hostname() || "")).slice(0, 80) || null,
  }, timeoutMs);
  if (!r.ok) {
    // Every failure except a plain timeout (or 408) backs off for 30 s, so no process is started on
    // every prompt; a timeout is tried again at the next prompt. The failure is kept so the person
    // is told once per session.
    if (!(r.code === "timeout" || r.status === 408)) markFailure("connect");
    const code = String(r.status || r.code || "error").slice(0, 40);
    try { withGlobal((g) => { g.connect_fail = { at: Date.now(), code }; }); } catch { /* ignore */ }
    recordError(`could not start a connect request (${code})`);
    log("connect.start_failed", { code: r.code, status: r.status });
    return null;
  }
  clearFailure("connect");
  try { withGlobal((g) => { delete g.connect_fail; }); } catch { /* ignore */ }
  const c = updateConnect((x) => {
    // Another process may have made a live request while we were waiting on the service: keep
    // that one (it is the one being polled) and drop ours. A forced request replaces it.
    if (!force && isLive(x)) return { ...x, kept: true };
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
  if (!c.kept) log("connect.started", {});
  delete c.kept;
  ensurePoller(c);
  return c;
}

// The detached child behind `connect-start`: create the request for the prompt hook to find.
export async function runCreator() {
  try {
    if (apiKey().key || disabledReason()) return;
    await ensureRequest({ host: process.env.INTENT_HOST === "codex" ? "codex" : "claude-code", hostVersion: process.env.INTENT_HOST_VERSION || "unknown", timeoutMs: 10000, claim: Number(process.env.INTENT_CLAIM) || 1 });
  } catch (e) {
    log("error", { cmd: "connect-start", ...errFields(e) });
  } finally {
    // Only our own claim: a newer creator's must stay.
    releaseClaim(Number(process.env.INTENT_CLAIM) || 0);
  }
}

export function ensurePoller(c = readConnect()) {
  if (!isLive(c) || pollerAlive(c)) return;
  const pid = spawnDetachedCmd("connect-poll");
  updateConnect((x) => { if (!pollerAlive(x)) { x.poller_pid = pid; x.poller_at = Date.now(); } });
}

// Take the poller role unless another live process has it.
function claimPoller(me = process.pid) {
  return updateConnect((x) => {
    if (x.poller_pid === me) { x.poller_at = Date.now(); return true; }
    if (holderAlive(x, "poller")) return false;
    x.poller_pid = me;
    x.poller_at = Date.now();
    return true;
  });
}

// A request that was replaced or finished: the key is only handed out once, so a loser of a
// poll race sees "consumed"; that must not undo the winner's "approved".
function markEnded(status, deviceCode) {
  updateConnect((x) => {
    if (x.status !== "pending" || (deviceCode && x.device_code !== deviceCode)) return;
    x.status = status;
    delete x.device_code;
  });
}

// Apply one poll response for the request deviceCode. Returns "approved" | "pending" | "gone".
export function applyPoll(r, deviceCode) {
  if (!r.ok) {
    if (r.status === 404) { markEnded("expired", deviceCode); return "gone"; }
    return "pending";
  }
  if (r.status === "approved" && r.api_key) {
    // Save the key first, inside the connect lock and only while this very request is still pending
    // (a newer request in the meantime means nobody wants this key). The service
    // hands the key out once, so nothing may be acknowledged before it is on disk; if saving
    // fails, say so instead of pretending to be connected.
    const res = updateConnect((x) => {
      if (x.status !== "pending" || (deviceCode && x.device_code !== deviceCode)) return "stale";
      try {
        saveApiKey(r.api_key);
      } catch (e) {
        log("connect.save_failed", errFields(e));
        recordError(`could not save the key (${(e && e.code) || "error"})`);
        x.status = "save_failed";
        delete x.device_code;
        return "failed";
      }
      x.status = "approved"; x.announce = true; x.handle = r.handle || null; delete x.device_code;
      return "ok";
    });
    if (res === "ok") log("connect.approved", {});
    return res === "ok" ? "approved" : "gone";
  }
  if (r.status === "pending") return "pending";
  // denied, expired, or consumed (someone else already picked the key up).
  if (apiKey().source === "config") {
    // We lost a race with ourselves; the key is saved. Make sure the connection gets announced once.
    updateConnect((x) => { if (x.status === "approved" && !x.announced && !x.announce) x.announce = true; });
    return "approved";
  }
  markEnded(r.status === "approved" ? "save_failed" : r.status, deviceCode);
  return "gone";
}

// One GET, used by the prompt hook as a fallback when the poller died. 1 s budget.
export async function checkConnectOnce(timeoutMs = C.polling.pending_check_timeout_ms) {
  const c = readConnect();
  if (!isLive(c) || backedOff("connect_poll", POLL_BACKOFF_MS)) return "none";
  const r = await pollConnect(c.device_code, timeoutMs);
  if (!r.ok && (!r.status || r.status >= 500)) markFailure("connect_poll");
  return applyPoll(r, c.device_code);
}

// "connected" is announced once, by whichever process sees it first. Returns { handle } or null.
export function takeConnectedAnnouncement() {
  const c = readConnect();
  if (!c || !c.announce) return null;
  return updateConnect((x) => {
    if (!x.announce) return null;
    delete x.announce;
    x.announced = true;
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
    if ((apiKey().key && apiKey().source === "config") || disabledReason()) {
      // The key landed between our read of connect.json and now: look again, the announcement is there.
      const w = watch ? watch(readConnect()) : null;
      return w || null;
    }
    if (claimPoller() && Date.now() >= nextPoll) {
      const interval = Math.max(1000, (c.interval_s || 3) * 1000);
      await sleep(nextPoll ? 0 : interval);
      const fresh = readConnect();
      if (!isLive(fresh)) continue;
      const r = await pollConnect(fresh.device_code, 10000);
      // Service unreachable for a couple of minutes: stop; the next prompt re-checks and restarts us.
      failures = r.ok || r.status ? 0 : failures + 1;
      if (applyPoll(r, fresh.device_code) !== "pending") continue;
      nextPoll = Date.now() + (r.status === 429 ? 30000 : interval); // 429: back off
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
    if (x.waiter_pid !== process.pid && holderAlive(x, "waiter")) return false;
    x.waiter_pid = process.pid;
    x.waiter_at = Date.now();
    return true;
  });
  if (!mine) return { exit: 0 };
  const r = await runLoop({
    deadline: Date.now() + budgetMs,
    watch: (c) => {
      const d = done(c) || (skipped() ? { exit: 0 } : null);
      if (!d) updateConnect((x) => { if (x.waiter_pid === process.pid) x.waiter_at = Date.now(); });
      return d;
    },
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
  if (r.status === 401) {
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
    if (!isLive(readConnect())) updateConnect((x) => { for (const k of Object.keys(x)) delete x[k]; Object.assign(x, { status: "revoked", api_url: apiUrl(), at: Date.now() }); });
    if (spawn) spawnCreator();
  } catch (e) {
    log("error", { cmd: "mark-revoked", ...errFields(e) });
  }
}

export const lastError = () => loadGlobal().last_error || null;
