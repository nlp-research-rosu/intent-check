// Host-neutral hook handlers. Each returns { user, context } for the host adapter to print
// (user: a line the person sees; context: text for the agent), or a runner outcome for Stop.
import path from "node:path";
import fs from "node:fs";
import { apiKey, disabledReason, liveMode, isInteractiveEntrypoint, C, dataDir, ensureDataDir, BIN, pluginVersion } from "./config.js";
import { sleep } from "./fsutil.js";
import { sessionKey, withSession, withGlobal, gcSessions, loadSession } from "./state.js";
import { ensureRequest, checkConnectOnce, takeConnectedAnnouncement, readConnect, spawnCreator, isLive, linkToken, runWaiter, connectedText, connectFailure } from "./connect.js";
import { checkLatePending, drainNotes, runStop, runEdit, runShellScan, spawnDetached, spawnEditJob, SCAN_RESERVE_MS } from "./runner.js";
import { pausedFor } from "./pause.js";
import * as g from "./git.js";
import * as shadow from "./shadow.js";
import { shadowCandidate } from "./changes.js";
import { spawn } from "node:child_process";
import { log, errFields } from "./log.js";
import { clip } from "./text.js";
import { applyPatchPaths, readTurnContext, codexModes, fixModeFor } from "./codex.js";
import { classifyPath } from "./filter.js";
import { discardQueue, repoRoot } from "./queue.js";

const L = C.limits;

export const CONSENT = "Intent Check is on. After a turn that changes source files, it sends your recent prompts, the diffs, the changed files and .intent/NOTES.md (if present) to the Intent Check service for a background review; obvious secrets are masked first. Each upload is listed in .intent/.sent.log. To turn it off: /intent:off";
const CONSENT_CONTEXT = "The Intent Check plugin is active: code changes are reviewed in the background, and concerns may arrive later as notes. The user can turn it off with /intent:off.";
export const connectLine = (url) => `Intent Check: connect your account → ${url}`;

export function isTaskNotification(prompt) {
  return typeof prompt === "string" && prompt.trimStart().startsWith("<task-notification>");
}

// Blocks a host injects into the user-role message (Claude Desktop's browser tooling, system
// reminders, local command output). The user never typed them, so they are not prompts.
const INJECTED_TAGS = ["browser_instruction", "system-reminder", "local-command-stdout", "local-command-caveat"];

// The prompt without leading harness-injected blocks: whatever the user typed after them, or ""
// when nothing is left (an unclosed block counts as all injected).
export function stripInjected(prompt) {
  let p = typeof prompt === "string" ? prompt.trimStart() : "";
  for (;;) {
    const tag = INJECTED_TAGS.find((t) => p.startsWith(`<${t}>`));
    if (!tag) return p.trim() === "" ? "" : p;
    const end = p.indexOf(`</${tag}>`);
    if (end === -1) return "";
    p = p.slice(end + tag.length + 3).trimStart();
  }
}

function isSubstantive(prompt) {
  const p = prompt.trim();
  return p.length >= 20 && !p.startsWith("/");
}

function out() {
  const user = [];
  const context = [];
  const claims = []; // DeepScan ids to confirm as delivered once the output is written
  return {
    user, context, claims,
    add(u, c) {
      if (u) user.push(u);
      if (c) context.push(c);
    },
    result() {
      return { user: user.join("\n"), context: context.join("\n\n"), claims };
    },
  };
}

// Codex does not load plugin slash commands, so its users are told the other ways to turn it off.
export const CONSENT_CODEX = CONSENT.replace("To turn it off: /intent:off", "To turn it off: ask the agent to turn Intent Check off, or set INTENT_DISABLED=1");
const CONSENT_CONTEXT_CODEX = "The Intent Check plugin is active: code changes are reviewed in the background, and concerns may arrive later as notes. If the user wants it off, follow the intent-check skill (it runs the plugin's off command), or they can set INTENT_DISABLED=1.";

function showConsentOnce(o, host = "claude-code") {
  const shown = withGlobal((gl) => {
    if (gl.consent_shown_at) return true;
    gl.consent_shown_at = new Date().toISOString();
    return false;
  });
  if (!shown) o.add(host === "codex" ? CONSENT_CODEX : CONSENT, host === "codex" ? CONSENT_CONTEXT_CODEX : CONSENT_CONTEXT);
}

// The first run after an install or update says the plugin is alive, so a silent hook is never
// the first sign of it.
export const readyLine = () => `Intent Check v${pluginVersion()} ready`;
function showReadyOnce(o) {
  const v = pluginVersion();
  const shown = withGlobal((gl) => {
    if (gl.ready_version === v) return true;
    gl.ready_version = v;
    return false;
  });
  if (!shown) o.add(readyLine());
}

// Codex asks the user to re-approve a plugin hook whose definition changed. A release that edits
// hooks/codex-hooks.json says so once per version (SessionStart itself is unchanged, so it still runs).
export const hookNotice = (v) => `Intent Check ${v} updated its edit hook. If Codex lists it as Modified, approve it in /hooks (or the app's hook review).`;
function showHookNoticeOnce(o) {
  const v = pluginVersion();
  const shown = withGlobal((gl) => {
    if (gl.hook_notice_version === v) return true;
    gl.hook_notice_version = v;
    return false;
  });
  if (!shown) o.add(hookNotice(v));
}

// Connect-link UX. Without a key the user sees the link once per session (and again whenever the
// state changes: a new request replaces the old one, which changes linkToken), and the agent is
// told to show it and wait for "done" or "skip". Creating the request is not done on the prompt
// path (1 s budget): SessionStart creates it, or a detached child does, and the prompt only
// reads connect.json.
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export function connectGate(url, reason, host) {
  return [
    reason ? `Intent Check: ${reason}` : null,
    "Intent Check is not connected yet, so nothing is being checked.",
    `Before doing anything else, show the user this connect link and ask them to open it and approve the connection: ${url}`,
    'Then wait: do not start on their request until they reply "done" or "skip". If they reply "skip", carry on with their request without connecting.',
    host === "codex" ? null : "Intent Check confirms here by itself once the connection is approved.",
  ].filter(Boolean).join("\n");
}
// Headless runs (claude -p, the SDKs) have nobody to ask: a note, not a stop-and-wait order.
export function connectNote(url) {
  return `Intent Check is not connected, so nothing is checked; the user can connect at ${url}`;
}
const CONNECT_APPROVED_CONTEXT = "The user approved the connection. Carry on with their original request.";
export const CONNECT_SKIPPED_CONTEXT = "The user chose to skip connecting Intent Check. Carry on with their request and do not bring up the connection again this session.";

const connectReply = (text) => {
  const m = /^\s*(done|skip)\s*[.!]*\s*$/i.exec(text || "");
  return m ? m[1].toLowerCase() : null;
};

function announce(o) {
  if (takeConnectedAnnouncement()) o.add(connectedText(), connectedText());
}

async function waitApproved(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkConnectOnce();
    if (apiKey().key) return true;
    const c = readConnect();
    if (!c || c.status !== "pending") return !!apiKey().key;
    await sleep(100);
  }
  return !!apiKey().key;
}

// phase "start": SessionStart (10 s budget) creates the request. phase "prompt" only reads it.
// SessionStart's budget stays well under the 8 s watchdog (create 3 s + late results 1 s),
// so the once-only consent and ready lines are never lost to a watchdog exit.
async function connectFlow(o, key, payload, { phase, host, text = "" }) {
  const headless = host !== "codex" && !isInteractiveEntrypoint(process.env.CLAUDE_CODE_ENTRYPOINT || "");
  checkConnectOnce(); // the CLI may have saved the key, or died, since the last hook
  // A command in this session showed the link itself: remember it, so only this session skips the link.
  if (phase === "prompt" && /^\/intent:(on|live|doctor|deepscan)\b/.test(text.trim())) withSession(key, (s) => { s.flags.connect_cmd = true; });
  if (apiKey().key) {
    announce(o);
    // The CLI saved the key before the user's "done": the gated agent still needs the go-ahead.
    const gated = phase === "prompt" && !!loadSession(key).flags.connect_gate && withSession(key, (s) => {
      const g = !!s.flags.connect_gate;
      delete s.flags.connect_gate;
      return g;
    });
    if (gated && connectReply(text) === "done") o.add("", CONNECT_APPROVED_CONTEXT);
    return;
  }
  let c = readConnect();
  if (phase === "start") {
    c = await ensureRequest({ timeoutMs: 3000 });
  } else if (!isLive(c)) {
    spawnCreator();
    c = null;
  }
  if (!isLive(c)) {
    // Creating the link failed: say so once per session instead of staying silent.
    const f = connectFailure();
    if (f && withSession(key, (s) => { if (s.flags.connect_fail_shown) return false; s.flags.connect_fail_shown = true; return true; })) {
      o.add(`Intent Check could not create a connect link (${f.code}). Run /intent:doctor to retry.`);
    }
    return;
  }
  const token = linkToken(c);
  const url = c.verification_url;
  const reply = phase === "prompt" ? connectReply(text) : null;
  const gated = withSession(key, (s) => s.flags.connect_gate === token);
  if (reply && gated) {
    if (reply === "skip") {
      withSession(key, (s) => { s.flags.connect_skipped = token; });
      o.add("", CONNECT_SKIPPED_CONTEXT);
      return;
    }
    if (await waitApproved(2500)) {
      announce(o);
      o.add("", CONNECT_APPROVED_CONTEXT);
    } else {
      o.add("", `The user says they approved, but Intent Check does not see it yet. Ask them to open ${url} and approve it there, then reply "done" again, or reply "skip" to carry on without connecting.`);
    }
    return;
  }
  if (phase === "prompt" && text.trim().startsWith("/intent:")) return; // a plugin command: nothing to gate
  // A command already showed this link in this session; other sessions still get theirs.
  if (c.cmd_shown && withSession(key, (s) => !!s.flags.connect_cmd)) {
    withSession(key, (s) => { s.flags.connect_shown = token; s.flags.connect_gate = token; });
    return;
  }
  const r = withSession(key, (s) => {
    const out = { line: s.flags.connect_shown !== token, gate: phase === "prompt" && s.flags.connect_gate !== token && s.flags.connect_skipped !== token };
    if (out.line) s.flags.connect_shown = token;
    if (out.gate) s.flags.connect_gate = token;
    return out;
  });
  if (r.line) {
    if (c.reason) o.add(`Intent Check: ${cap(c.reason)}`);
    o.add(connectLine(url));
  }
  if (r.gate) o.add("", headless ? connectNote(url) : connectGate(url, c.reason, host));
}

async function deliverPending(o, key, host, cwd = null) {
  if (apiKey().key) await checkLatePending(key);
  if (cwd && fs.existsSync(path.join(dataDir(), "deepscans"))) {
    try {
      const root = await g.toplevel(cwd);
      if (root) await (await import("./deepscan.js")).checkLateDeepscans(o, root);
    } catch (e) { log("deepscan.deliver_failed", errFields(e)); }
  }
  const n = drainNotes(key, { host });
  o.add(n.user, n.context);
}

export async function sessionStart(payload, { host = "claude-code" } = {}) {
  if (disabledReason()) return { user: "", context: "" };
  ensureDataDir();
  if (Math.random() < 0.1) gcSessions();
  const key = sessionKey(payload.session_id);
  const o = out();
  showConsentOnce(o, host);
  showReadyOnce(o);
  if (host === "codex") showHookNoticeOnce(o);
  await connectFlow(o, key, payload, { phase: "start", host });
  await deliverPending(o, key, host, payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  return o.result();
}

// A git baseline when the repo has commits. Otherwise (no repo, or no commit yet) a shadow
// snapshot of the work tree, kept apart from git's own state; if that is not possible either,
// null / a sha-less baseline and only the paths the agent touched are reviewed.
async function captureBaseline(cwd, { skipShadow = false } = {}) {
  const repo = await g.toplevel(cwd);
  let b = null;
  if (repo) {
    if (await g.revParseHead(repo)) {
      const [base, untracked] = await Promise.all([g.captureBaseline(repo), g.listUntracked(repo)]);
      return { repo, sha: base.sha, head: base.head, untracked, at: Date.now() };
    }
    // No commit yet: the shadow snapshot replaces the untracked list (which could walk node_modules).
    b = { repo, sha: null, head: null, untracked: {}, at: Date.now() };
  }
  if (skipShadow) return b;
  let root = repo;
  if (!root) { try { root = fs.realpathSync(cwd); } catch { return b; } }
  const sh = await shadow.snapshot(root, shadowCandidate);
  if (!sh) return b;
  return { ...(b || { repo: null, sha: null, head: null, untracked: {} }), at: Date.now(), shadow: sh };
}

export async function prompt(payload, { host = "claude-code" } = {}) {
  if (disabledReason()) return { user: "", context: "" };
  ensureDataDir();
  const key = sessionKey(payload.session_id);
  const text = typeof payload.prompt === "string" ? payload.prompt : "";
  const notification = isTaskNotification(text);
  const typed = stripInjected(text); // what the user actually wrote
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // The last Stop never consumed its paths: its baseline is kept below, so skip a new snapshot.
  const prev = loadSession(key);
  const basePromise = captureBaseline(cwd, { skipShadow: prev.touched.length > 0 && !!(prev.baseline && prev.baseline.shadow) });
  const o = out();
  showConsentOnce(o, host);
  showReadyOnce(o);
  const connectPromise = connectFlow(o, key, payload, { phase: "prompt", host, text: typed });
  // Record the prompt before waiting on the baseline: a watchdog exit then loses at most the baseline.
  withSession(key, (s) => {
    if (!notification && typed.trim() && !typed.trim().startsWith("/intent:")) {
      const id = payload.prompt_id || payload.turn_id; // Claude Code: prompt_id; Codex: turn_id
      const pid = typeof id === "string" && id ? id : null;
      s.prompt_ids.length = s.prompts.length;
      s.prompts.push(clip(typed, L.prompt_chars * 4));
      s.prompt_ids.push(pid);
      if (s.prompts.length > L.max_prompts) {
        s.prompts.splice(0, s.prompts.length - L.max_prompts);
        s.prompt_ids.splice(0, s.prompt_ids.length - L.max_prompts);
      }
      if (!s.first_prompt && isSubstantive(typed)) { s.first_prompt = clip(typed, L.prompt_chars * 4); s.first_prompt_id = pid; }
      s.prompt_count += 1;
      s.turn_id = typeof id === "string" && id ? id : `turn-${s.prompt_count}`;
    }
    if (typeof payload.permission_mode === "string") s.permission_mode = payload.permission_mode;
  });
  const [baseline] = await Promise.all([basePromise, connectPromise]);
  withSession(key, (s) => {
    // If the last Stop never consumed its paths (interrupted turn), keep the older baseline so
    // the next Stop still sees those edits (security-guidance behaviour).
    const preserve = s.touched.length > 0 && s.baseline && (s.baseline.sha || s.baseline.shadow);
    if (!preserve) s.baseline = baseline;
  });

  await deliverPending(o, key, host, cwd);
  return o.result();
}

const PATCH_LINES_CAP = 400;

// Returns { user, context } when live-review findings are waiting for the agent.
export function postTool(payload, { host = "claude-code" } = {}) {
  if (disabledReason()) return;
  const tool = payload.tool_name;
  if (tool === "Bash" || tool === "PowerShell") return shellTool(payload, host);
  ensureDataDir();
  const key = sessionKey(payload.session_id);
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const resp = payload.tool_response && typeof payload.tool_response === "object" ? payload.tool_response : {};
  withSession(key, (s) => {
    if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
      const p = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
      if (typeof p !== "string" || !p) return;
      if (!s.touched.includes(p)) s.touched.push(p);
      if (s.touched.length > 200) s.touched.splice(0, s.touched.length - 200);
      // Without a git baseline, Claude Code's structuredPatch is the only diff source.
      if (!(s.baseline && s.baseline.sha) && Array.isArray(resp.structuredPatch)) {
        const list = s.patches[p] || [];
        let lines = list.reduce((n, h) => n + ((h && h.lines && h.lines.length) || 0), 0);
        for (const h of resp.structuredPatch.slice(0, 20)) {
          if (!h || !Array.isArray(h.lines) || lines + h.lines.length > PATCH_LINES_CAP) break;
          list.push({ oldStart: h.oldStart | 0, oldLines: h.oldLines | 0, newStart: h.newStart | 0, newLines: h.newLines | 0, lines: h.lines.map(String) });
          lines += h.lines.length;
        }
        s.patches[p] = list;
      }
    } else if (tool === "apply_patch") {
      // Codex edits arrive as a patch; take its paths (shell-written files are caught by the baseline diff at Stop, and by the shell scan in live mode).
      for (const p of applyPatchPaths(input.command, payload.cwd)) if (!s.touched.includes(p)) s.touched.push(p);
      if (s.touched.length > 200) s.touched.splice(0, s.touched.length - 200);
    } else if (tool === "ExitPlanMode") {
      if (typeof input.plan === "string" && input.plan.trim()) s.plan = clip(input.plan, L.plan_chars * 2);
    } else if (tool === "TodoWrite") {
      if (Array.isArray(input.todos)) {
        s.todos = input.todos
          .map((t) => (t && typeof t.content === "string" ? t.content : typeof t === "string" ? t : ""))
          .filter(Boolean)
          .slice(0, L.max_todos)
          .map((t) => clip(t, L.todo_chars));
      }
    }
  });
  if (!liveMode()) return;
  spawnEditCheck(payload, host);
  return carriedConcerns(key, host);
}

// Findings from earlier edits' checks: a local read, no network.
function carriedConcerns(key, host) {
  const n = drainNotes(key, { host, only: "concerns" });
  return n.context ? { user: "", context: n.context } : undefined;
}

// A shell command may have written files, and its payload names none. In live mode a detached
// child looks at the working tree; this hook does no git and no network work. Bursts coalesce:
// one scan runs at a time per session, and a call that arrives meanwhile asks it for another pass.
function shellTool(payload, host) {
  if (!liveMode()) return;
  ensureDataDir();
  const key = sessionKey(payload.session_id);
  if (usableKey()) {
    const go = withSession(key, (s) => {
      if (!(s.baseline && (s.baseline.sha || s.baseline.shadow))) return false; // no git or shadow baseline: nothing to diff against
      const cur = s.flags.shell_scan;
      if (cur && Date.now() - cur.at < SCAN_RESERVE_MS) {
        cur.again = true;
        return false;
      }
      s.flags.shell_scan = { at: Date.now(), again: false };
      return true;
    });
    if (go) {
      const dir = path.join(dataDir(), "tmp");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `edit-scan-${process.pid}-${Date.now()}.json`);
      const job = { session_id: payload.session_id, cwd: payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), tool_use_id: payload.tool_use_id || `t${Date.now()}`, prompt_id: payload.prompt_id || payload.turn_id || null, transcript_path: payload.transcript_path || null, host };
      fs.writeFileSync(file, JSON.stringify(job), { mode: 0o600 });
      if (!spawnDetached(["shell-scan-detached", file])) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        withSession(key, (s) => { delete s.flags.shell_scan; });
      }
    }
  }
  return carriedConcerns(key, host);
}

// No key or a paused key: nothing to send.
function usableKey() {
  const k = apiKey();
  return !!k.key && !pausedFor(k.key);
}

// Live mode: hand this edit to a detached process that submits and polls it. The hook does
// no git and no network work itself. Claude Code names one file per call; a Codex apply_patch
// can name several, and each gets its own check.
function spawnEditCheck(payload, host) {
  const tool = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let paths;
  if (tool === "apply_patch") paths = applyPatchPaths(input.command, cwd);
  else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) paths = [tool === "NotebookEdit" ? input.notebook_path : input.file_path];
  else return;
  if (!usableKey()) return;
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const rel = path.relative(cwd, path.resolve(cwd, p)).split(path.sep).join("/");
    if (classifyPath(rel) === "no") continue;
    // Past the in-flight cap, Stop still covers the content.
    if (!spawnEditJob({ session_id: payload.session_id, cwd, path: p, tool_use_id: payload.tool_use_id || `t${Date.now()}`, prompt_id: payload.prompt_id || payload.turn_id || null, transcript_path: payload.transcript_path || null, host })) break;
  }
}

// Stop. Interactive Claude Code: run the runner here (the hook is already in the background).
// Headless (claude -p, SDK): hand off to a detached process and return at once, because -p
// waits for asyncRewake hooks and would run an extra turn on exit 2.
export async function stop(payload, { interactive, startedAt }) {
  if (disabledReason()) {
    withSession(sessionKey(payload.session_id), (s) => { s.touched = []; s.patches = {}; });
    // Reviews queued before checks were turned off are dropped, not sent later.
    try { discardQueue(repoRoot(payload.cwd || process.cwd())); } catch { /* no queue */ }
    return { exit: 0 };
  }
  if (!interactive) {
    ensureDataDir();
    const dir = path.join(dataDir(), "tmp");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `stop-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    const child = spawn(process.execPath, [BIN, "stop-detached", file], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    child.unref();
    log("stop.detached", {});
    return { exit: 0 };
  }
  const canWake = payload.stop_hook_active !== true;
  return runStop(payload, { canWake, startedAt });
}

// Codex Stop: sync (timeout 30 s), never waits for a result. If an earlier job's concerns are
// already waiting, hand them over now through exit 2 (Codex continues the turn with them), unless
// this Stop ends such a continuation. Then submit this turn's changes and hand polling to a
// detached finisher; its results arrive with the next prompt.
export async function stopCodex(payload) {
  const key = sessionKey(payload.session_id);
  if (disabledReason()) {
    withSession(key, (s) => { s.touched = []; s.patches = {}; });
    try { discardQueue(repoRoot(payload.cwd || process.cwd())); } catch { /* no queue */ }
    return { exit: 0 };
  }
  ensureDataDir();
  const modes = codexModes(readTurnContext(payload.transcript_path));
  const r = await runStop(payload, { canWake: false, host: "codex", poll: false, codexModes: modes, fixMode: fixModeFor(modes), submitTimeoutMs: 8000, submitBudgetMs: 15000 });
  if (payload.stop_hook_active === true || !apiKey().key) return { exit: 0 };
  await checkLatePending(key);
  // r.text: per-edit concerns runStop already carried (it drained them from the notes).
  const n = drainNotes(key, { host: "codex", only: "concerns" });
  const text = [r && r.exit === 2 ? r.text : "", n.context].filter(Boolean).join("\n\n");
  if (text) return { exit: 2, text };
  return { exit: 0 };
}

// The connect-wait Stop hook (Claude Code only, asyncRewake): wakes the agent the moment the
// connection is approved. Headless entrypoints are skipped: claude -p waits for asyncRewake hooks.
export async function connectWait(payload, { interactive }) {
  if (!interactive || disabledReason()) return { exit: 0 };
  const key = sessionKey(payload.session_id);
  const skipped = () => {
    const t = linkToken(readConnect());
    return !!t && loadSession(key).flags.connect_skipped === t;
  };
  return runWaiter({ skipped });
}

export async function stopDetached(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  return runStop(payload, { canWake: false });
}


export async function editDetached(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  return runEdit(payload);
}

export async function shellScanDetached(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  return runShellScan(payload);
}
