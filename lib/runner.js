// The review runner: the Stop hook running in the background (asyncRewake). It consumes the
// turn's state, submits a job, polls it, writes .intent/ and delivers the result: exit 2 to
// wake the agent when there are concerns, otherwise a note for the next prompt.
// The state machine (locked read-then-clear, restore on transient failure, fire cap, finding
// dedupe, loop guard) is ported from Anthropic's security-guidance plugin (Apache-2.0, NOTICE).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { C, BIN, apiKey, apiUrl, clearSavedApiKey, hostVersion, disabledReason, pluginVersion } from "./config.js";
import { withSession, loadSession, sessionKey, loadGlobal, withGlobal } from "./state.js";
import { collectChanges } from "./changes.js";
import { buildRequest, idempotencyKey } from "./payload.js";
import { submitJob, getJob, isHttpUrl } from "./api.js";
import { writeUnit, appendSentLog } from "./intentdir.js";
import { validConcerns, concernText, summaryLine, noConcernsText, hhmm } from "./render.js";
import { sha256, sleep, isPidAlive } from "./fsutil.js";
import { log, errFields } from "./log.js";
import { backedOff, markFailure, clearFailure, isNetworkFailure, POLL_BACKOFF_MS } from "./backoff.js";

const P = C.polling;
export const FIRE_CAP = 3;
export const FIRE_WINDOW_MS = 2 * 60 * 1000;
export const FILE_WAKE_WINDOW_MS = 10 * 60 * 1000;
export const DEDUPE_MS = 60 * 60 * 1000;
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000;
const FINISHER_BUDGET_MS = 30 * 60 * 1000;
const MAX_NOTES = 10;

export function addNote(s, text, { user = false, once = null } = {}) {
  if (once) {
    s.flags.notes_once = s.flags.notes_once || {};
    if (s.flags.notes_once[once]) return;
    s.flags.notes_once[once] = Date.now();
  }
  s.notes.push({ text, user, at: Date.now() });
  if (s.notes.length > MAX_NOTES) s.notes.splice(0, s.notes.length - MAX_NOTES);
}

function currentHash(root, rel) {
  try { return sha256(fs.readFileSync(path.join(root, rel))); } catch { return null; }
}

// Settle one finished job under the session lock. Returns { kind: "wake"|"note"|"none", text?, summary? }.
export function settle(key, job, status, { canWake }) {
  const now = Date.now();
  const sentPaths = (job.sent || []).map((x) => x.rel);
  const result = status.status === "done" && status.result && typeof status.result === "object" ? status.result : null;
  const url = isHttpUrl(status.url) ? status.url : job.url;

  if (result) {
    let written = 0;
    for (const u of Array.isArray(result.units) ? result.units : []) {
      if (!u || !sentPaths.includes(u.path) || !/^[0-9a-f]{64}$/.test(u.checked_sha256 || "")) continue;
      try {
        if (writeUnit(job.repo, u, { job_id: job.job_id, url }, result)) written++;
      } catch (e) {
        log("intentdir.write_failed", errFields(e));
      }
    }
    log("job.done", { job: job.job_id, verdict: result.verdict, units: written });
  } else {
    log("job.ended", { job: job.job_id, status: status.status, code: status.error && status.error.code });
  }

  return withSession(key, (s) => {
    const idx = s.pending.findIndex((p) => p.job_id === job.job_id);
    if (idx === -1) return { kind: "none" }; // someone else already delivered it
    s.pending.splice(idx, 1);
    if (!result) return { kind: "none" };

    s.flags.delivered = s.flags.delivered || {};
    for (const [k, t] of Object.entries(s.flags.delivered)) if (now - t > DEDUPE_MS) delete s.flags.delivered[k];
    const all = validConcerns(result, sentPaths);
    const fresh = all.filter((c) => !s.flags.delivered[sha256(`${c.path}\n${c.type}\n${c.title}`)]);
    if (!all.length) {
      addNote(s, noConcernsText(url, result.partial === true));
      return { kind: "note" };
    }
    if (!fresh.length) return { kind: "none" };
    for (const c of fresh) s.flags.delivered[sha256(`${c.path}\n${c.type}\n${c.title}`)] = now;

    const unitsByPath = new Map((result.units || []).filter((u) => u && typeof u.path === "string").map((u) => [u.path, u]));
    const stale = [];
    for (const p of new Set(fresh.map((c) => c.path))) {
      const sent = (job.sent || []).find((x) => x.rel === p);
      const checked = (unitsByPath.get(p) && unitsByPath.get(p).checked_sha256) || (sent && sent.sha256);
      const cur = currentHash(job.repo, p);
      if (checked && cur && cur !== checked) stale.push({ path: p, at: hhmm(result.checked_at) });
    }
    const text = concernText({ concerns: fresh, url, permissionMode: job.permission_mode, stale, partial: result.partial === true });

    s.wakes = s.wakes.filter((t) => now - t < FIRE_WINDOW_MS);
    for (const [p, t] of Object.entries(s.woken)) if (now - t > FILE_WAKE_WINDOW_MS) delete s.woken[p];
    const recentlyWoken = fresh.some((c) => s.woken[c.path]);
    if (canWake && job.wake !== false && s.wakes.length < FIRE_CAP && !recentlyWoken) {
      s.wakes.push(now);
      for (const c of fresh) s.woken[c.path] = now;
      return { kind: "wake", text, summary: summaryLine(fresh) };
    }
    addNote(s, text);
    return { kind: "note" };
  });
}

function spawnDetached(args) {
  try {
    const child = spawn(process.execPath, [BIN, ...args], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function releaseOwner(key, token) {
  try {
    withSession(key, (s) => { if (s.owner && s.owner.token === token) s.owner = null; });
  } catch { /* ignore */ }
}

// Poll every pending job of the session until one wakes the agent, all settle, or the budget ends.
// A newer runner taking ownership makes this one exit quietly.
// finisher: a detached finisher never starts another one, so hand-offs cannot chain.
export async function pollLoop(key, { canWake, deadline, onTerm, finisher = false }) {
  const token = crypto.randomBytes(8).toString("hex");
  withSession(key, (s) => { s.owner = { pid: process.pid, token, at: Date.now() }; });
  let terminated = false;
  const term = () => {
    if (terminated) return;
    terminated = true;
    releaseOwner(key, token);
    if (!finisher && loadSession(key).pending.length) spawnDetached(["finish", key]);
    if (onTerm) onTerm();
    process.exit(0);
  };
  process.on("SIGTERM", term);
  process.on("SIGHUP", term);
  process.on("SIGINT", term);

  const k = apiKey().key;
  let delay = P.initial_ms;
  try {
    while (Date.now() < deadline) {
      if (disabledReason()) return { exit: 0 }; // /intent:off takes effect mid-poll too
      const s = loadSession(key);
      if (!s.owner || s.owner.token !== token) return { exit: 0 };
      const jobs = s.pending.filter((j) => Date.now() - (j.submitted_at || 0) < PENDING_MAX_AGE_MS);
      if (!jobs.length) return { exit: 0 };
      for (const job of jobs) {
        const r = await getJob(k, job.job_id, 10000);
        if (!r.ok) {
          if (r.status === 404 || r.status === 401) {
            withSession(key, (x) => { x.pending = x.pending.filter((p) => p.job_id !== job.job_id); });
            log("job.dropped", { job: job.job_id, status: r.status });
          }
          continue;
        }
        if (!["done", "failed", "superseded"].includes(r.job.status)) continue;
        const out = settle(key, job, r.job, { canWake });
        if (out.kind === "wake") return { exit: 2, text: out.text, summary: out.summary };
      }
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(Math.round(delay * 1.5), P.max_ms);
    }
    if (!finisher && loadSession(key).pending.length) spawnDetached(["finish", key]);
    return { exit: 0 };
  } finally {
    process.removeListener("SIGTERM", term);
    process.removeListener("SIGHUP", term);
    process.removeListener("SIGINT", term);
    releaseOwner(key, token);
  }
}

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

function pause(key, code) {
  const source = apiKey().source;
  try { withGlobal((g) => { g.paused = { id: pauseId(key), code, source, at: new Date().toISOString() }; }); } catch { /* ignore */ }
}

const pausedNote = (p) => (p.code === 426
  ? "Intent Check: checks are paused because this plugin version is too old for the service. Update the intent plugin to resume."
  : "Intent Check: checks are paused because the API key was not accepted.");

function handleSubmitFailure(key, res, snap) {
  if (res.status === 401 || res.status === 426) pause(apiKey().key, res.status);
  withSession(key, (s) => {
    const code = res.code;
    if (res.status === 401) {
      if (apiKey().source === "config") clearSavedApiKey(apiKey().key);
      else addNote(s, "Intent Check: the API key in INTENT_API_KEY was not accepted, so checks are paused.", { user: true, once: "paused:401" });
      return;
    }
    if (res.status === 426) {
      addNote(s, "Intent Check: this plugin version is too old for the service. Update it with: claude plugin update intent@intentcomputing", { user: true, once: "paused:426" });
      return;
    }
    if (res.status === 429) {
      const text = code === "spend_cap"
        ? "Intent Check: today's free check limit was reached, so recent changes were not checked. Checks resume tomorrow."
        : code === "blocked"
          ? "Intent Check: checks are paused for this account."
          : "Intent Check: too many checks in a short time, so recent changes were not checked.";
      addNote(s, text, { user: true, once: `429:${code}` });
      return;
    }
    if (res.status === 0 || res.status >= 500) {
      // Transient: put the paths back so the next Stop retries them (security-guidance restore).
      const merged = [...new Set([...(snap.touched || []), ...s.touched])].slice(0, 200);
      s.touched = merged;
      if (!s.baseline && snap.baseline) s.baseline = snap.baseline;
    }
  });
  log("job.submit_failed", { status: res.status, code: res.code, reason: res.reason });
}

// Consume the turn's state (locked read-then-clear). PostToolUse writes after this belong to the next turn.
export function consumeTurn(key) {
  return withSession(key, (s) => {
    const snap = {
      touched: [...s.touched],
      patches: s.patches,
      baseline: s.baseline,
      prompts: [...s.prompts],
      first_prompt: s.first_prompt,
      plan: s.plan,
      todos: [...s.todos],
      turn_id: s.turn_id,
    };
    s.touched = [];
    s.patches = {};
    return snap;
  });
}

// payload: the Stop hook stdin. Returns { exit, text?, summary? }.
export async function runStop(payload, { canWake, startedAt = Date.now(), host = "claude-code" }) {
  const key = sessionKey(payload.session_id);
  const k = apiKey();
  const snap = consumeTurn(key);
  if (!k.key) return { exit: 0 };
  const paused = pausedFor(k.key);
  if (paused) {
    withSession(key, (s) => addNote(s, pausedNote(paused), { user: true, once: `paused:${paused.code}` }));
    return { exit: 0 };
  }

  // Killed before the job was submitted: put the turn's paths back for the next Stop.
  const preSubmitTerm = () => {
    handleSubmitFailure(key, { status: 0, code: "terminated" }, snap);
    process.exit(0);
  };
  process.on("SIGTERM", preSubmitTerm);
  try {
    return await submitAndPoll();
  } finally {
    process.removeListener("SIGTERM", preSubmitTerm);
  }

  async function submitAndPoll() {
    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const ch = await collectChanges(snap, cwd);
    const sessionHash = key; // already a hash of the host session id
    const turnId = payload.prompt_id || snap.turn_id || `t${Date.now()}`;
    const built = buildRequest({
      files: ch.files, root: ch.root, snap, stop: payload, sessionHash, turnId,
      host, hostVersion: hostVersion(payload.transcript_path),
    });
    if (!built) {
      log("stop.nothing_to_check", { files: ch.files.length, git: ch.git });
      return { exit: 0 };
    }
    const idem = idempotencyKey(sessionHash, turnId, built.sent);
    const bytes = Buffer.byteLength(JSON.stringify(built.request));
    const res = await submitJob(k.key, built.request, idem);
    process.removeListener("SIGTERM", preSubmitTerm);
    appendSentLog(ch.root, {
      time: new Date().toISOString(),
      url: `${apiUrl()}/v1/jobs`,
      status: res.ok ? "sent" : `failed:${res.status || res.code}`,
      job_id: res.ok ? res.job_id : null,
      report: res.ok ? res.url : null,
      paths: built.sent.map((x) => x.rel),
      bytes,
      redactions: built.redactions,
    });
    if (!res.ok) {
      handleSubmitFailure(key, res, snap);
      return { exit: 0 };
    }
    log("job.submitted", { job: res.job_id, units: built.sent.length, bytes, redactions: built.redactions });
    withSession(key, (s) => {
      s.pending.push({
        job_id: res.job_id,
        url: res.url,
        repo: ch.root,
        sent: built.sent.map((x) => ({ rel: x.rel, sha256: x.sha256 })),
        permission_mode: typeof payload.permission_mode === "string" ? payload.permission_mode : null,
        turn_id: turnId,
        submitted_at: Date.now(),
        wake: canWake,
      });
    });
    return pollLoop(key, { canWake, deadline: startedAt + P.runner_budget_ms });
  }
}

// Detached finisher: keeps polling after the hook was killed; never wakes, leaves notes.
export async function runFinisher(key) {
  return pollLoop(key, { canWake: false, deadline: Date.now() + FINISHER_BUDGET_MS, finisher: true });
}

// Late results, checked at the next prompt or session start: one GET per job, ~1 s total.
// Jobs a live runner is still polling are left to it.
export async function checkLatePending(key, timeoutMs = P.pending_check_timeout_ms) {
  const s = loadSession(key);
  if (s.owner && isPidAlive(s.owner.pid)) return;
  const now = Date.now();
  const stale = s.pending.filter((j) => now - (j.submitted_at || 0) >= PENDING_MAX_AGE_MS);
  if (stale.length) withSession(key, (x) => { x.pending = x.pending.filter((j) => now - (j.submitted_at || 0) < PENDING_MAX_AGE_MS); });
  const jobs = s.pending.filter((j) => now - (j.submitted_at || 0) < PENDING_MAX_AGE_MS).slice(-5);
  if (!jobs.length) return;
  const k = apiKey().key;
  if (!k || backedOff("jobs", POLL_BACKOFF_MS)) return;
  const results = await Promise.all(jobs.map((j) => getJob(k, j.job_id, timeoutMs)));
  if (results.every(isNetworkFailure)) markFailure("jobs");
  else clearFailure("jobs");
  results.forEach((r, i) => {
    if (r.ok && ["done", "failed", "superseded"].includes(r.job.status)) settle(key, jobs[i], r.job, { canWake: false });
  });
}

// Take all queued notes. Returns { context, user } strings (either may be empty).
export function drainNotes(key) {
  return withSession(key, (s) => {
    const notes = s.notes;
    s.notes = [];
    return {
      context: notes.map((n) => n.text).join("\n\n"),
      user: notes.filter((n) => n.user).map((n) => n.text).join("\n"),
    };
  });
}
