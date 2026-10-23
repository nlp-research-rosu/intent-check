// Connect-link onboarding: `intent-check login` (the CLI) creates the request, polls the console and saves the
// API key; the plugin starts it detached, shows its link and watches for the key. The request lives in
// ${CLAUDE_PLUGIN_DATA}/connect.json and records the service (api_url) it was made for; the CLI's output goes to
// connect-login-<created_at>.out next to it.
//
// Who does what:
// - SessionStart (10 s budget) or a detached `connect-start` child (which also downloads the CLI when it is
//   missing) creates the request; the prompt hook (1 s budget) only reads connect.json.
// - The CLI process (poller_pid) is the poller. Whoever sees its key in the credentials file first marks the
//   request approved and announces it once. On Claude Code the `connect-wait` Stop hook (asyncRewake) only
//   watches and wakes the agent the moment that happens.
// - Every state change (denied, expired, consumed, revoked, another service) leaves a record
//   whose status explains why the next link is shown (reasonFor).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { dataDir, ensureDataDir, apiKey, apiUrl, BIN, disabledReason } from "./config.js";
import { readJson, writeJsonAtomic, withLock, isPidAlive, sleep } from "./fsutil.js";
import { isOwnLink } from "./api.js";
import { cliOnDisk, proveCommand } from "./cli.js";
import { log, errFields } from "./log.js";
import { withGlobal, loadGlobal } from "./state.js";
import { backedOff, markFailure, clearFailure, CONNECT_BACKOFF_MS } from "./backoff.js";

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
  return !!c && c.status === "pending" && typeof c.poller_pid === "number" && c.expires_at > now + 30000 && (!c.api_url || c.api_url === apiUrl());
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
    case "failed": return "the service could not create a key for the last connect request.";
    case "revoked": return "your saved key is no longer accepted (revoked or expired).";
    case "save_failed": return "the key from the last connection could not be saved.";
    case "pending": return prev.expires_at <= now + 30000 ? "the last connect link expired." : null;
    case "approved": return "your saved key is no longer available.";
    default: return null;
  }
}

// A pid alone is not proof (pids are reused): the waiter refreshes waiter_at every loop tick, and a
// heartbeat older than 15 s means dead.
export function holderAlive(c, role, now = Date.now()) {
  if (!c || !isPidAlive(c[`${role}_pid`])) return false;
  const at = c[`${role}_at`];
  return typeof at === "number" && now - at < 15000;
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
export function spawnCreator(now = Date.now()) {
  if (backedOff("connect", CONNECT_BACKOFF_MS, now)) return false;
  const stamp = takeClaim(now);
  if (!stamp) return false;
  const pid = spawnDetachedCmd("connect-start", { INTENT_CLAIM: String(stamp) });
  if (pid === null) releaseClaim(stamp);
  return pid !== null;
}

// Why creating the last request failed (shown once per session).
export function connectFailure() {
  const f = loadGlobal().connect_fail;
  return f && typeof f.at === "number" && Date.now() - f.at < 10 * 60 * 1000 ? f : null;
}

const outFile = (created) => path.join(dataDir(), `connect-login-${created}.out`);

// The complete JSON lines the CLI has printed for the request made at `created`.
function loginLines(created) {
  try {
    return fs.readFileSync(outFile(created), "utf8").split("\n").slice(0, -1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

const killPid = (pid) => { try { process.kill(pid); } catch { /* already gone */ } };

// Why creating the request failed: kept so the person is told once per session. Every failure except a
// plain timeout backs off for 30 s, so no process is started on every prompt; a timeout is tried again at
// the next prompt.
function connectFailed(code, backoff = true) {
  if (backoff) markFailure("connect");
  try { withGlobal((g) => { g.connect_fail = { at: Date.now(), code }; }); } catch { /* ignore */ }
  recordError(`could not start a connect request (${code})`);
  log("connect.start_failed", { code });
}

// Start `intent-check login` detached and wait up to timeoutMs for its first line (the link).
async function startLogin(bin, timeoutMs) {
  const created = Date.now();
  const fd = fs.openSync(outFile(created), "w", 0o600);
  let child;
  try {
    // A .js path is the dev/test override: it lets the Node fake run on Windows.
    child = spawn(...(bin.endsWith(".js") ? [process.execPath, [bin, "login"]] : [bin, ["login"]]), { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: { ...process.env, INTENT_API_URL: apiUrl() } });
    child.on("error", () => {});
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
  const end = Date.now() + timeoutMs;
  while (child.pid && !loginLines(created).length && isPidAlive(child.pid) && Date.now() < end) await sleep(50);
  const [first] = loginLines(created);
  if (first && first.status === "pending" && /^[A-Z]{4}-[A-Z]{4}$/.test(first.user_code) && isOwnLink(first.verification_url) && first.verification_url.endsWith(`/connect/${first.user_code}`)
    && Number.isInteger(first.expires_in) && first.expires_in >= 1 && first.expires_in <= 900) {
    return { ok: true, created, pid: child.pid, user_code: first.user_code, verification_url: first.verification_url, expires_in: first.expires_in };
  }
  if (child.pid) killPid(child.pid);
  return { ok: false, code: !child.pid ? "spawn" : !first && Date.now() >= end ? "timeout" : "login" };
}

// Create a connect request unless one is live. Returns the live record or null.
// timeoutMs: SessionStart has 10 s; the detached child can take its time.
// claim: the creation claim the caller already holds (the detached child); otherwise one is taken
// here, and a caller that finds another creator at work waits for its record instead of making a second.
// Without the CLI on disk the creator is started to download it (never inline: SessionStart has 8 s) and
// the link comes at the next prompt.
export async function ensureRequest({ timeoutMs = 5000, force = false, claim = null } = {}) {
  let c = readConnect();
  if (!force && isLive(c)) return c;
  if (!force && backedOff("connect", CONNECT_BACKOFF_MS)) return null;
  let bin;
  try {
    bin = cliOnDisk();
  } catch {
    connectFailed("cli");
    return null;
  }
  if (!bin) {
    if (!claim) spawnCreator();
    return null;
  }
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
      return isLive(c) ? c : null;
    }
  }
  try {
    return await createRequest({ timeoutMs, force, prev: c, bin });
  } finally {
    releaseClaim(mine);
  }
}

async function createRequest({ timeoutMs, force, prev, bin }) {
  const reason = reasonFor(prev);
  if (force && isLive(prev)) killPid(prev.poller_pid); // one login at a time
  const r = await startLogin(bin, timeoutMs);
  if (!r.ok) {
    connectFailed(r.code, r.code !== "timeout");
    return null;
  }
  clearFailure("connect");
  try { withGlobal((g) => { delete g.connect_fail; }); } catch { /* ignore */ }
  const c = updateConnect((x) => {
    // Another process may have made a live request while we were starting ours: keep that one
    // and drop ours. A forced request replaces it.
    if (!force && isLive(x)) return { ...x, kept: true };
    for (const k of Object.keys(x)) delete x[k];
    Object.assign(x, {
      status: "pending",
      api_url: apiUrl(),
      user_code: r.user_code,
      verification_url: r.verification_url,
      expires_at: r.created + r.expires_in * 1000,
      created_at: r.created,
      poller_pid: r.pid,
      ...(reason ? { reason } : {}),
    });
    return { ...x };
  });
  if (c.kept) {
    killPid(r.pid);
    fs.rmSync(outFile(r.created), { force: true });
  } else {
    log("connect.started", {});
  }
  delete c.kept;
  // Output of older requests is no longer needed.
  for (const f of fs.readdirSync(dataDir())) if (/^connect-login-\d+\.out$/.test(f) && Number(f.slice(14, -4)) < c.created_at) fs.rmSync(path.join(dataDir(), f), { force: true });
  return c;
}

// The detached child behind `connect-start`: get the CLI, then create the request for the prompt hook to find.
export async function runCreator() {
  try {
    if (apiKey().key || disabledReason()) return;
    try {
      await proveCommand();
    } catch (e) {
      connectFailed("download");
      log("connect.download_failed", errFields(e));
      return;
    }
    await ensureRequest({ timeoutMs: 10000, claim: Number(process.env.INTENT_CLAIM) || 1 });
  } catch (e) {
    log("error", { cmd: "connect-start", ...errFields(e) });
  } finally {
    // Only our own claim: a newer creator's must stay.
    releaseClaim(Number(process.env.INTENT_CLAIM) || 0);
  }
}

// How the CLI ended without a key: the status on its last line, else failed.
function markEnded(c) {
  const last = loginLines(c.created_at).pop();
  const status = last && ["denied", "expired", "consumed", "failed"].includes(last.status) ? last.status : "failed";
  updateConnect((x) => { if (x.status === "pending" && x.created_at === c.created_at) x.status = status; });
}

// The watch step, no HTTP: the CLI saved a key for this service (approved, announced once by whichever
// process sees it first), or it is gone without one (ended). A dead login is not restarted: the next prompt
// starts a fresh one, as for an expired request.
export function checkConnectOnce() {
  const c = readConnect();
  if (!c || c.status !== "pending") return "none";
  if (apiKey().source === "file") {
    if (updateConnect((x) => { if (x.status !== "pending") return false; x.status = "approved"; x.announce = true; return true; })) log("connect.approved", {});
    return "approved";
  }
  if (c.poller_pid && !isPidAlive(c.poller_pid)) {
    markEnded(c);
    return "gone";
  }
  return "pending";
}

// "connected" is announced once, by whichever process sees it first. Returns true or null.
export function takeConnectedAnnouncement() {
  const c = readConnect();
  if (!c || !c.announce) return null;
  return updateConnect((x) => {
    if (!x.announce) return null;
    delete x.announce;
    x.announced = true;
    return true;
  });
}

export const connectedText = () => "Intent Check connected";

// Watch until the request ends. watch(c) may return a value to stop with. Returns that value, or null
// when the request ended or time ran out.
async function runLoop({ deadline, watch = null }) {
  while (Date.now() < deadline) {
    checkConnectOnce();
    const c = readConnect();
    if (watch) { const w = watch(c); if (w) return w; }
    if (!isLive(c)) return null;
    await sleep(1000);
  }
  return null;
}

// The `connect-wait` Stop hook (Claude Code, asyncRewake). Returns { exit: 2, text, summary } the
// moment the key is saved, otherwise { exit: 0 } without a word: when the request is denied,
// expired, consumed or skipped the next prompt explains.
export async function runWaiter({ skipped = () => false, budgetMs = 870000 } = {}) {
  if (disabledReason()) return { exit: 0 };
  const done = (c) => {
    if (c && c.announce) {
      if (takeConnectedAnnouncement()) return { exit: 2, text: `${connectedText()}. Tell the user in one short line that Intent Check is now connected, then carry on with their original request (the connect step is finished).`, summary: connectedText() };
    }
    return null;
  };
  checkConnectOnce();
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
