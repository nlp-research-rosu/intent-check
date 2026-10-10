// The review runner: the Stop hook running in the background (asyncRewake). It consumes the
// turn's state, submits a job, polls it, writes .intent/ and delivers the result: exit 2 to
// wake the agent when there are concerns, otherwise a note for the next prompt.
// The state machine (locked read-then-clear, restore on transient failure, fire cap, finding
// dedupe, loop guard) is ported from Anthropic's security-guidance plugin (Apache-2.0, NOTICE).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { C, BIN, dataDir, apiKey, apiUrl, clearSavedApiKey, hostVersion, disabledReason, pluginVersion, perEditMode } from "./config.js";
import { withSession, loadSession, promptsUpTo, sessionKey, loadGlobal, withGlobal } from "./state.js";
import { markRevoked } from "./connect.js";
import { collectChanges, toRel } from "./changes.js";
import { buildRequest, idempotencyKey } from "./payload.js";
import { submitJob, getJob, isHttpUrl } from "./api.js";
import { writeUnit, appendSentLog, syncUnits } from "./intentdir.js";
import { takeQueue, checkPath, enqueue } from "./queue.js";
import { pausedFor, pause, pausedNote } from "./pause.js";
import { MAX_FILE_BYTES } from "./changes.js";
import { validConcerns, concernText, summaryLine, noConcernsText, noConcernsUserText, skippedFilesText, hhmm } from "./render.js";
import { sha256, sleep, isPidAlive } from "./fsutil.js";
import { log, errFields } from "./log.js";
import { readTurnContext, codexModes as codexModesOf, fixModeFor } from "./codex.js";
import { backedOff, markFailure, clearFailure, isNetworkFailure, POLL_BACKOFF_MS } from "./backoff.js";

const P = C.polling;
export const FIRE_CAP = 3;
export const FIRE_WINDOW_MS = 2 * 60 * 1000;
export const FILE_WAKE_WINDOW_MS = 10 * 60 * 1000;
export const DEDUPE_MS = 60 * 60 * 1000;
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000;
const FINISHER_BUDGET_MS = 30 * 60 * 1000;
const MAX_NOTES = 10;
const MAX_QUEUE_ATTEMPTS = 3;

// kind: "concerns" | "quiet" (no-concerns lines, which Codex keeps silent) | "skipped" | "info".
// userText: a different line for the user than the model gets (text always goes to
// additionalContext; the user sees userText if given, else text, when user is true).
export function addNote(s, text, { user = false, userText = null, once = null, kind = "info" } = {}) {
  if (once) {
    s.flags.notes_once = s.flags.notes_once || {};
    if (s.flags.notes_once[once]) return;
    s.flags.notes_once[once] = Date.now();
  }
  s.notes.push({ text, user, userText, kind, at: Date.now() });
  if (s.notes.length > MAX_NOTES) s.notes.splice(0, s.notes.length - MAX_NOTES);
}

function currentHash(root, rel, abs) {
  try { return sha256(fs.readFileSync(abs || path.join(root, rel))); } catch { return null; }
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
        if (writeUnit(job.repo, u, { job_id: job.job_id, url, ...(job.edit ? { submitted_at: job.submitted_at } : {}) }, result)) written++;
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
    // A per-edit job is also tracked in edit_jobs; whoever settles it first (its own poller or
    // the Stop runner that adopted it) claims it, the other finds nothing left to do.
    const ej = job.edit ? s.edit_jobs[job.job_id] : null;
    const mine = ej && !ej.settled;
    if (idx === -1 && !mine) return { kind: "none" }; // someone else already delivered it
    if (idx !== -1) s.pending.splice(idx, 1);
    if (mine) {
      if (result) ej.settled = true; // kept so Stop does not resubmit the same content
      else delete s.edit_jobs[job.job_id];
    }
    if (!result) return { kind: "none" };

    s.flags.delivered = s.flags.delivered || {};
    for (const [k, t] of Object.entries(s.flags.delivered)) if (now - t > DEDUPE_MS) delete s.flags.delivered[k];
    const all = validConcerns(result, sentPaths);
    const fresh = all.filter((c) => !s.flags.delivered[sha256(`${c.path}\n${c.type}\n${c.title}`)]);
    if (!all.length) {
      addNote(s, noConcernsText(url, result.partial === true, sentPaths), {
        kind: "quiet",
        user: true,
        userText: noConcernsUserText(url, sentPaths),
      });
      return { kind: "note" };
    }
    if (!fresh.length) return { kind: "none" };
    for (const c of fresh) s.flags.delivered[sha256(`${c.path}\n${c.type}\n${c.title}`)] = now;

    const unitsByPath = new Map((result.units || []).filter((u) => u && typeof u.path === "string").map((u) => [u.path, u]));
    const stale = [];
    for (const p of new Set(fresh.map((c) => c.path))) {
      const sent = (job.sent || []).find((x) => x.rel === p);
      const checked = (unitsByPath.get(p) && unitsByPath.get(p).checked_sha256) || (sent && sent.sha256);
      const cur = currentHash(job.repo, p, sent && sent.abs);
      if (checked && cur && cur !== checked) stale.push({ path: p, at: hhmm(result.checked_at) });
    }
    const text = concernText({ concerns: fresh, url, permissionMode: job.permission_mode, stale, partial: result.partial === true, host: job.host });

    s.wakes = s.wakes.filter((t) => now - t < FIRE_WINDOW_MS);
    for (const [p, t] of Object.entries(s.woken)) if (now - t > FILE_WAKE_WINDOW_MS) delete s.woken[p];
    const recentlyWoken = fresh.some((c) => s.woken[c.path]);
    if (canWake && job.wake !== false && s.wakes.length < FIRE_CAP && !recentlyWoken) {
      s.wakes.push(now);
      for (const c of fresh) s.woken[c.path] = now;
      return { kind: "wake", text, summary: summaryLine(fresh) };
    }
    addNote(s, text, { kind: "concerns" });
    return { kind: "note" };
  });
}

export function spawnDetached(args) {
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
            withSession(key, (x) => { x.pending = x.pending.filter((p) => p.job_id !== job.job_id); delete x.edit_jobs[job.job_id]; });
            log("job.dropped", { job: job.job_id, status: r.status });
          }
          continue;
        }
        if (!["done", "failed", "superseded"].includes(r.job.status)) continue;
        const out = settle(key, job, r.job, { canWake });
        if (out.kind === "wake") {
          // Other jobs still running are handed to a finisher; their results become notes.
          if (!finisher && loadSession(key).pending.length) spawnDetached(["finish", key]);
          return { exit: 2, text: out.text, summary: out.summary };
        }
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

// What /intent:status shows as "last check" and "last error".
function recordCheck(ok, why) {
  try {
    withGlobal((g) => {
      g.last_check = { at: new Date().toISOString(), ok };
      if (!ok) g.last_error = { at: g.last_check.at, text: String(why).slice(0, 200) };
    });
  } catch { /* status only */ }
}

// usedKey: the key the failed request was sent with. Children run concurrently and the key can
// change meanwhile, so a 401 only acts on the current key when it is still that key.
export function handleSubmitFailure(key, res, snap, usedKey) {
  if (usedKey && (res.status === 401 || res.status === 426)) pause(usedKey, res.status);
  recordCheck(false, res.status ? `the service answered ${res.status}${res.code ? ` (${res.code})` : ""}` : `could not reach the service (${res.code || "error"})`);
  withSession(key, (s) => {
    const code = res.code;
    if (res.status === 401) {
      const cur = apiKey();
      if (!usedKey || cur.key !== usedKey) return; // already handled, or the key was replaced since
      if (cur.source === "config") {
        // The saved key is dead: forget it and get a new link ready, with the reason on it.
        clearSavedApiKey(cur.key);
        markRevoked();
      } else addNote(s, "Intent Check: the API key in INTENT_API_KEY was not accepted, so checks are paused.", { user: true, once: "paused:401" });
      return;
    }
    if (res.status === 426) {
      addNote(s, "Intent Check: this plugin version is too old for the service. Update the intent plugin to keep checks running.", { user: true, once: "paused:426" });
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
    if (res.status === 0) {
      addNote(s, "Intent Check: couldn't reach the service, so recent changes haven't been checked yet. They will be once it's back.", { user: true, once: "network" });
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
// turnId: the Stop payload's prompt_id/turn_id; later prompts are left out of this turn's snapshot.
export function consumeTurn(key, turnId = null) {
  return withSession(key, (s) => {
    const v = promptsUpTo(s, turnId);
    const snap = {
      touched: [...s.touched],
      patches: s.patches,
      baseline: s.baseline,
      prompts: v.prompts,
      first_prompt: v.first_prompt,
      plan: s.plan,
      todos: [...s.todos],
      turn_id: v.turn_id,
    };
    s.touched = [];
    s.patches = {};
    return snap;
  });
}

// payload: the Stop hook stdin. Returns { exit, text?, summary? }.
// poll: false (Codex) submits, hands polling to a detached finisher and returns at once.
// codexModes: raw Codex modes for the request; the fix rule then comes from fixModeFor().
export async function runStop(payload, { canWake, startedAt = Date.now(), host = "claude-code", poll = true, codexModes = null, fixMode = null, submitTimeoutMs = 20000, submitBudgetMs = Infinity }) {
  const key = sessionKey(payload.session_id);
  const k = apiKey();
  const snap = consumeTurn(key, payload.prompt_id || payload.turn_id);
  if (!k.key) return { exit: 0 };
  const paused = pausedFor(k.key);
  if (paused) {
    withSession(key, (s) => addNote(s, pausedNote(paused), { user: true, once: `paused:${paused.code}` }));
    return { exit: 0 };
  }

  // Killed before the job was submitted: put the turn's paths back for the next Stop.
  const preSubmitTerm = () => {
    handleSubmitFailure(key, { status: 0, code: "terminated" }, snap, k.key);
    process.exit(0);
  };
  process.on("SIGTERM", preSubmitTerm);
  try {
    return await withCarried(await submitAndPoll());
  } finally {
    process.removeListener("SIGTERM", preSubmitTerm);
  }

  // Per-edit mode: concerns from finished per-edit checks that no edit has carried to the agent
  // yet wake it here, together with whatever the poll below finds. Codex Stop cannot wake
  // (canWake is false), but hands them over through its exit 2, except when this Stop ends such
  // a continuation.
  async function withCarried(r) {
    if (!perEditMode() || !(host === "codex" ? payload.stop_hook_active !== true : canWake)) return r;
    const n = drainNotes(key, { only: "concerns" });
    if (!n.context) return r;
    if (r && r.exit === 2) return { ...r, text: `${n.context}\n\n${r.text}` };
    return { exit: 2, text: n.context, summary: "Intent Check found concerns" };
  }

  async function submitAndPoll() {
    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const ch = await collectChanges(snap, cwd);
    let adopted = 0;
    if (perEditMode()) {
      // Files a per-edit check already covers (same content, finished or in flight) are not sent again.
      const covered = Object.values(loadSession(key).edit_jobs).filter((e) => e.settled || Date.now() - e.submitted_at < PENDING_MAX_AGE_MS);
      ch.files = ch.files.filter((f) => !covered.some((e) => e.rel === f.rel && e.sha256 === sha256(f.buf)));
      // Per-edit checks still running join this runner's poll; a late concern wakes the agent.
      adopted = withSession(key, (s) => {
        let n = 0;
        for (const e of Object.values(s.edit_jobs)) {
          if (!e.settled && Date.now() - e.submitted_at >= PENDING_MAX_AGE_MS) { delete s.edit_jobs[e.job_id]; continue; }
          if (e.settled || s.pending.some((p) => p.job_id === e.job_id)) continue;
          s.pending.push({ ...e, edit: true, wake: canWake });
          n++;
        }
        return n;
      });
    }
    try { syncUnits(ch.root, ch); } catch (e) { log("intentdir.sync_failed", errFields(e)); }
    const sessionHash = key; // already a hash of the host session id
    const turnId = payload.prompt_id || snap.turn_id || `t${Date.now()}`;
    const common = { root: ch.root, snap, stop: payload, sessionHash, host, hostVersion: hostVersion(payload.transcript_path), codexModes };
    const jobs = [];
    // Real path: the queue CLI resolved paths against the real repo folder.
    let root = ch.root;
    try { root = fs.realpathSync(ch.root); } catch { /* keep as is */ }
    const queue = takeQueue(root);
    // A file that was also queued for review goes in the request job only (a later job for the
    // same path would supersede the edit job anyway).
    const queued = new Set(queue.flatMap((q) => q.paths));
    const edit = buildRequest({ ...common, files: ch.files.filter((f) => !queued.has(f.rel)), turnId });
    if (edit) jobs.push({ built: edit, idem: idempotencyKey(sessionHash, turnId, edit.sent) });
    for (const q of queue) {
      const built = buildRequest({ ...common, files: queuedFiles(root, q.paths, q.worktree), turnId: `${turnId}:${q.mode}`, mode: q.mode });
      // Keyed by the queue item and file contents, not the session or turn: a retry of the same
      // request replays the server's original job instead of creating another one.
      if (built) jobs.push({ built, idem: idempotencyKey("queue", q.id, built.sent), queued: q });
    }
    if (!jobs.length && !adopted) {
      const skipped = ch.skipped || [];
      log("stop.nothing_to_check", { files: ch.files.length, git: ch.git, skipped: skipped.length });
      // Only when every changed file was excluded by the filter, not when the turn simply had
      // nothing worth checking (below the 3-changed-lines threshold has no entries here at all).
      if (!ch.files.length && skipped.length) {
        const reasons = [...new Set(skipped.map((x) => x.reason))].sort().join("+");
        withSession(key, (s) => addNote(s, skippedFilesText(skipped.map((x) => x.rel)), { user: true, once: `skipped:${reasons}` }));
      }
      return { exit: 0 };
    }
    let submittedAny = false;
    // counted: this item itself got a 5xx or timed out. Untried items, an unreachable service,
    // 401/426/429 (spend cap included) and a budget cut-off put items back unchanged.
    const requeue = (q, counted = false) => {
      if (!counted) {
        try { enqueue(root, q.mode, q.paths, { id: q.id, attempts: q.attempts, worktree: q.worktree }); } catch (e) { log("queue.requeue_failed", errFields(e)); }
        return;
      }
      if (q.attempts + 1 >= MAX_QUEUE_ATTEMPTS) {
        withSession(key, (s) => addNote(s, `Intent Check: gave up on a requested review of ${q.paths.length} file${q.paths.length === 1 ? "" : "s"} after ${MAX_QUEUE_ATTEMPTS} failed attempts.`, { user: true }));
        log("queue.dropped", { id: q.id, attempts: q.attempts + 1 });
        return;
      }
      try { enqueue(root, q.mode, q.paths, { id: q.id, attempts: q.attempts + 1, worktree: q.worktree }); } catch (e) { log("queue.requeue_failed", errFields(e)); }
    };
    // A sync Stop (Codex) has a hard limit: stop submitting when the budget is spent and leave
    // the rest for the next Stop (queued reviews go back in the queue, edited paths are kept).
    const submitStart = Date.now();
    let finisherStarted = false;
    for (let i = 0; i < jobs.length; i++) {
      const { built, idem, queued: q } = jobs[i];
      const left = submitBudgetMs - (Date.now() - submitStart);
      if (left < 1000) {
        for (const rest of jobs.slice(i)) {
          if (rest.queued) requeue(rest.queued);
          else handleSubmitFailure(key, { status: 0, code: "budget" }, snap, k.key);
        }
        log("stop.submit_budget", { left: jobs.length - i });
        break;
      }
      const bytes = Buffer.byteLength(JSON.stringify(built.request));
      const res = await submitJob(k.key, built.request, idem, Math.min(submitTimeoutMs, left));
      appendSentLog(ch.root, {
        time: new Date().toISOString(),
        url: `${apiUrl()}/v1/jobs`,
        mode: built.request.mode,
        status: res.ok ? "sent" : `failed:${res.status || res.code}`,
        job_id: res.ok ? res.job_id : null,
        report: res.ok ? res.url : null,
        paths: built.sent.map((x) => x.rel),
        bytes,
        redactions: built.redactions,
      });
      if (!res.ok) {
        handleSubmitFailure(key, res, snap, k.key);
        if (res.status >= 500) {
          // The service answered but failed this job: retry it later (capped), carry on with the rest.
          if (q) requeue(q, true);
          continue;
        }
        if (!res.status || res.status === 401 || res.status === 426 || res.status === 429) {
          // Unreachable, or every job would be refused the same way: stop, and put this and the
          // remaining queued reviews back for the next Stop.
          if (q) requeue(q, !res.status && res.code === "timeout");
          for (const rest of jobs.slice(i + 1)) if (rest.queued) requeue(rest.queued);
          break;
        }
        continue; // 400/413: this job cannot be sent as is; the others still can
      }
      submittedAny = true;
      recordCheck(true);
      log("job.submitted", { job: res.job_id, mode: built.request.mode, units: built.sent.length, bytes, redactions: built.redactions });
      withSession(key, (s) => {
        if (s.flags.notes_once) delete s.flags.notes_once.network; // reachable again: a later outage is told again
        s.pending.push({
          job_id: res.job_id,
          url: res.url,
          repo: ch.root,
          mode: built.request.mode,
          sent: built.sent.map((x) => ({ rel: x.rel, sha256: x.sha256, ...(x.abs ? { abs: x.abs } : {}) })),
          permission_mode: fixMode || (typeof payload.permission_mode === "string" ? payload.permission_mode : null),
          host,
          turn_id: turnId,
          submitted_at: Date.now(),
          wake: canWake,
        });
      });
      // Codex: start polling in the background as soon as there is something to poll, so a
      // slow later submit (or the hook's own time limit) cannot lose it.
      if (!poll && !finisherStarted) finisherStarted = spawnDetached(["finish", key]);
    }
    process.removeListener("SIGTERM", preSubmitTerm);
    // The early finisher may have settled job 1 and exited before later jobs were submitted:
    // start a fresh one now (taking ownership makes any older one step aside).
    if (!poll && submittedAny && jobs.length > 1) spawnDetached(["finish", key]);
    // Adopted per-edit jobs have no poller of their own any more: on Codex the finisher polls them.
    if (!poll && adopted && !finisherStarted) spawnDetached(["finish", key]);
    if ((!submittedAny && !adopted) || !poll) return { exit: 0 };
    return pollLoop(key, { canWake, deadline: startedAt + P.runner_budget_ms });
  }
}

// Queued review requests: whole files, no diff. Paths are re-validated at submit time.
function queuedFiles(root, rels, worktree = null) {
  const base = worktree || root;
  const out = [];
  for (const rel of rels) {
    const r = checkPath(base, base, rel);
    if (r.error) continue;
    const abs = path.join(base, r.rel);
    try {
      const buf = fs.readFileSync(abs);
      if (buf.length > MAX_FILE_BYTES || buf.includes(0)) continue;
      out.push({ rel: r.rel, abs, buf, content: buf.toString("utf8"), diff: null, changed: 0, ...(worktree ? { worktree } : {}) });
    } catch { /* gone */ }
  }
  return out;
}

// Detached finisher: keeps polling after the hook was killed; never wakes, leaves notes.
export async function runFinisher(key) {
  return pollLoop(key, { canWake: false, deadline: Date.now() + FINISHER_BUDGET_MS, finisher: true });
}

// Per-edit check (detached, one per Edit/Write): submit just this file as its own job, without
// consuming the turn's state (Stop still has it), then poll that one job without taking
// ownership. Concerns become notes the next edit's PostToolUse hands to the agent; if Stop
// meanwhile adopted the job, its runner delivers (and may wake) instead.
const EDIT_POLL_BUDGET_MS = 30 * 60 * 1000;
const MAX_EDIT_JOBS = 100;
export const MAX_INFLIGHT_EDITS = 12;

// A spawned check holds a reservation in the session until its job is registered (or it gives up).
export const EDIT_RESERVE_MS = 30 * 1000;
// A spawned edit child that has not registered its job yet covers its file for this long (the Bash scan checks it).
export const EDIT_PENDING_MS = 60 * 1000;
function releaseEditSlot(key, id) {
  if (!id) return;
  try { withSession(key, (s) => { if (s.edit_reserved) delete s.edit_reserved[id]; if (s.edit_pending) delete s.edit_pending[id]; }); } catch { /* ignore */ }
}

// Hand one file to a detached edit check, under the in-flight cap. Returns whether it was spawned.
// job: { session_id, cwd, path, tool_use_id, prompt_id, transcript_path, host }. No git, no network.
export function spawnEditJob(job) {
  // Bounded fan-out, never a debounce: past the cap Stop still covers the content.
  // Children that were spawned but have not registered their job yet count too (expiring, so a crashed child frees its slot).
  const skey = sessionKey(job.session_id);
  const reserveId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let live = 0;
  withSession(skey, (s) => {
    const now = Date.now();
    s.edit_reserved = s.edit_reserved || {};
    s.edit_pending = s.edit_pending || {};
    for (const [id, at] of Object.entries(s.edit_reserved)) if (now - at > EDIT_RESERVE_MS) delete s.edit_reserved[id];
    for (const [id, p] of Object.entries(s.edit_pending)) if (now - p.at > EDIT_PENDING_MS) delete s.edit_pending[id];
    live = Object.values(s.edit_jobs).filter((e) => !e.settled && now - e.submitted_at < 30 * 60 * 1000).length + Object.keys(s.edit_reserved).length;
    if (live < MAX_INFLIGHT_EDITS) {
      s.edit_reserved[reserveId] = now;
      s.edit_pending[reserveId] = { abs: path.resolve(job.cwd || process.cwd(), job.path), at: now };
    }
  });
  if (live >= MAX_INFLIGHT_EDITS) {
    log("edit.capped", { live });
    return false;
  }
  const dir = path.join(dataDir(), "tmp");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `edit-${process.pid}-${Date.now()}-${reserveId.slice(-6)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...job, reserve_id: reserveId }), { mode: 0o600 });
  if (!spawnDetached(["edit-detached", file])) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    releaseEditSlot(skey, reserveId);
    return false;
  }
  log("edit.spawned", {});
  return true;
}

export async function runEdit(payload) {
  try {
    return await runEditInner(payload);
  } finally {
    releaseEditSlot(sessionKey(payload.session_id), payload.reserve_id);
  }
}

// A file whose current content a per-edit check already covers (finished or in flight).
// With abs, a fresh edit child that has spawned but not registered its job also covers the file
// (the sha is not known yet). Only the Bash scan asks for that.
function editCovered(s, rel, sha, abs = null) {
  const now = Date.now();
  if (Object.values(s.edit_jobs).some((e) => e.rel === rel && e.sha256 === sha && (e.settled || now - e.submitted_at < PENDING_MAX_AGE_MS))) return true;
  return !!abs && Object.values(s.edit_pending || {}).some((p) => p.abs === abs && now - p.at < EDIT_PENDING_MS);
}

// Shell-written files (per-edit mode). The Bash PostToolUse hook only marks a scan wanted
// (s.flags.shell_scan) and spawns this; a Bash burst coalesces into one child, which rescans if
// another call arrived while it ran. The scan diffs the working tree against the turn baseline,
// skips what a check already covers, and hands each remaining file to an edit check.
export const SCAN_RESERVE_MS = 60 * 1000;
const SCAN_PASSES = 3;
const MAX_SHELL_SEEN = 200;

export async function runShellScan(payload) {
  const key = sessionKey(payload.session_id);
  try {
    for (let pass = 0; pass < SCAN_PASSES; pass++) {
      log("shell.scan", { pass });
      await scanShellWrites(key, payload);
      // Read and clear "again" in one step, so a call that lands now is either seen here or starts its own scan.
      const again = withSession(key, (s) => {
        const f = s.flags.shell_scan;
        if (f && f.again && pass < SCAN_PASSES - 1) {
          s.flags.shell_scan = { at: Date.now(), again: false };
          return true;
        }
        delete s.flags.shell_scan;
        return false;
      });
      if (!again) break;
    }
  } finally {
    try { withSession(key, (s) => { delete s.flags.shell_scan; }); } catch { /* ignore */ }
  }
  return { exit: 0 };
}

async function scanShellWrites(key, payload) {
  const k = apiKey();
  if (!k.key || disabledReason() || pausedFor(k.key) || !perEditMode()) return;
  const s0 = loadSession(key);
  if (!(s0.baseline && s0.baseline.sha)) return;
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ch = await collectChanges({ touched: [], patches: {}, baseline: s0.baseline }, cwd);
  if (!ch.git) return;
  for (const f of ch.files) {
    const sha = sha256(f.buf);
    withSession(key, (x) => { if (x.flags.shell_scan) x.flags.shell_scan.at = Date.now(); }); // heartbeat: a long pass keeps its reservation
    const cur = loadSession(key);
    if (editCovered(cur, f.rel, sha, f.abs) || (cur.flags.shell_seen || {})[f.rel] === sha) continue;
    const ok = spawnEditJob({ session_id: payload.session_id, cwd, path: f.abs, tool_use_id: `bash-${payload.tool_use_id || Date.now()}`, prompt_id: payload.prompt_id || payload.turn_id || null, transcript_path: payload.transcript_path || null, host: payload.host === "codex" ? "codex" : "claude-code" });
    if (!ok) break; // capped or unspawnable: not marked, so a later scan (or Stop) picks it up
    withSession(key, (s) => {
      const seen = s.flags.shell_seen = s.flags.shell_seen || {};
      seen[f.rel] = sha;
      const rels = Object.keys(seen);
      for (const r of rels.slice(0, Math.max(0, rels.length - MAX_SHELL_SEEN))) delete seen[r];
    });
  }
}

async function runEditInner(payload) {
  const key = sessionKey(payload.session_id);
  const k = apiKey();
  if (!k.key || disabledReason() || pausedFor(k.key) || typeof payload.path !== "string") return { exit: 0 };
  const s0 = loadSession(key);
  const v0 = promptsUpTo(s0, payload.prompt_id);
  const snap = {
    touched: [payload.path],
    patches: s0.patches[payload.path] ? { [payload.path]: s0.patches[payload.path] } : {},
    baseline: s0.baseline,
    prompts: v0.prompts,
    first_prompt: v0.first_prompt,
    plan: s0.plan,
    todos: [...s0.todos],
    turn_id: v0.turn_id,
  };
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ch = await collectChanges(snap, cwd);
  // The git review set also holds the turn's other dirty files; this job is the one edited file.
  const rel = toRel(ch.root, payload.path);
  const files = ch.files.filter((f) => f.rel === rel || f.abs === payload.path);
  const turnId = payload.prompt_id || snap.turn_id || `t${Date.now()}`;
  // Codex: the real approval, sandbox and plan mode come from the transcript's latest turn_context.
  const host = payload.host === "codex" ? "codex" : "claude-code";
  const modes = host === "codex" ? codexModesOf(readTurnContext(payload.transcript_path)) : null;
  const permissionMode = host === "codex" ? fixModeFor(modes) : typeof s0.permission_mode === "string" ? s0.permission_mode : null;
  const built = buildRequest({ files, root: ch.root, snap, stop: { permission_mode: permissionMode }, sessionHash: key, host, hostVersion: hostVersion(payload.transcript_path), turnId, codexModes: modes, perEdit: true });
  if (!built) {
    log("edit.nothing_to_check", { files: ch.files.length });
    return { exit: 0 };
  }
  if (editCovered(loadSession(key), built.sent[0].rel, built.sent[0].sha256)) {
    log("edit.covered", {});
    return { exit: 0 };
  }
  const bytes = Buffer.byteLength(JSON.stringify(built.request));
  const res = await submitJob(k.key, built.request, idempotencyKey(key, `edit:${payload.tool_use_id}`, built.sent), 20000);
  appendSentLog(ch.root, {
    time: new Date().toISOString(),
    url: `${apiUrl()}/v1/jobs`,
    mode: built.request.mode,
    status: res.ok ? "sent" : `failed:${res.status || res.code}`,
    job_id: res.ok ? res.job_id : null,
    report: res.ok ? res.url : null,
    paths: built.sent.map((x) => x.rel),
    bytes,
    redactions: built.redactions,
  });
  if (!res.ok) {
    handleSubmitFailure(key, res, { touched: [] }, k.key); // Stop still has the path
    return { exit: 0 };
  }
  recordCheck(true);
  log("job.submitted", { job: res.job_id, mode: "edit-auto", units: built.sent.length, bytes, redactions: built.redactions });
  const job = {
    job_id: res.job_id,
    url: res.url,
    repo: ch.root,
    mode: built.request.mode,
    sent: built.sent.map((x) => ({ rel: x.rel, sha256: x.sha256, ...(x.abs ? { abs: x.abs } : {}) })),
    permission_mode: permissionMode,
    host,
    turn_id: turnId,
    submitted_at: Date.now(),
    edit: true,
  };
  withSession(key, (s) => {
    if (s.flags.notes_once) delete s.flags.notes_once.network; // reachable again: a later outage is told again
    s.edit_jobs[job.job_id] = { ...job, rel: built.sent[0].rel, sha256: built.sent[0].sha256 };
    if (s.edit_reserved && payload.reserve_id) delete s.edit_reserved[payload.reserve_id];
    if (s.edit_pending && payload.reserve_id) delete s.edit_pending[payload.reserve_id];
    const ids = Object.keys(s.edit_jobs).filter((id) => s.edit_jobs[id].settled);
    if (Object.keys(s.edit_jobs).length > MAX_EDIT_JOBS) {
      ids.sort((x, y) => s.edit_jobs[x].submitted_at - s.edit_jobs[y].submitted_at);
      for (const id of ids.slice(0, Object.keys(s.edit_jobs).length - MAX_EDIT_JOBS)) delete s.edit_jobs[id];
    }
  });
  return pollEdit(key, job);
}

// Same backoff as pollLoop, one job, never s.owner. Ends when the job settles (here or in the
// Stop runner that adopted it), is adopted by one, disappears, or the budget runs out.
async function pollEdit(key, job) {
  const k = apiKey().key;
  const deadline = Date.now() + EDIT_POLL_BUDGET_MS;
  let delay = P.initial_ms;
  while (Date.now() < deadline) {
    if (disabledReason()) return { exit: 0 };
    const cur = loadSession(key);
    const e = cur.edit_jobs[job.job_id];
    // Adopted by a Stop runner: it polls (and may wake the agent) from here.
    if (!e || e.settled || cur.pending.some((p) => p.job_id === job.job_id)) return { exit: 0 };
    const r = await getJob(k, job.job_id, 10000);
    if (!r.ok) {
      if (r.status === 404 || r.status === 401) {
        withSession(key, (x) => { delete x.edit_jobs[job.job_id]; x.pending = x.pending.filter((p) => p.job_id !== job.job_id); });
        log("job.dropped", { job: job.job_id, status: r.status });
        return { exit: 0 };
      }
    } else if (["done", "failed", "superseded"].includes(r.job.status)) {
      settle(key, job, r.job, { canWake: false });
      return { exit: 0 };
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(Math.round(delay * 1.5), P.max_ms);
  }
  return { exit: 0 };
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
  const dead = jobs.filter((j, i) => !results[i].ok && (results[i].status === 404 || results[i].status === 401));
  if (dead.length) withSession(key, (x) => { for (const j of dead) { delete x.edit_jobs[j.job_id]; } });
  results.forEach((r, i) => {
    if (r.ok && ["done", "failed", "superseded"].includes(r.job.status)) settle(key, jobs[i], r.job, { canWake: false });
  });
}

// Take all queued notes. Returns { context, user } strings (either may be empty).
// Codex shows injected context to the user, so it stays silent on no-concerns lines.
export function drainNotes(key, { host = "claude-code", only = null } = {}) {
  return withSession(key, (s) => {
    const take = (n) => !only || n.kind === only;
    const notes = s.notes.filter(take).filter((n) => !(host === "codex" && n.kind === "quiet"));
    s.notes = s.notes.filter((n) => !take(n));
    return {
      context: notes.map((n) => n.text).join("\n\n"),
      user: notes.filter((n) => n.user).map((n) => n.userText || n.text).join("\n"),
    };
  });
}
