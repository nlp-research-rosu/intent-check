// Host-neutral hook handlers. Each returns { user, context } for the host adapter to print
// (user: a line the person sees; context: text for the agent), or a runner outcome for Stop.
import path from "node:path";
import fs from "node:fs";
import { apiKey, disabledReason, C, dataDir, ensureDataDir, BIN, hostVersion } from "./config.js";
import { sessionKey, withSession, withGlobal, gcSessions } from "./state.js";
import { ensureConnectLink, checkConnectOnce, takeConnectedAnnouncement, readConnect, ensurePoller } from "./connect.js";
import { checkLatePending, drainNotes, runStop } from "./runner.js";
import * as g from "./git.js";
import { spawn } from "node:child_process";
import { log } from "./log.js";
import { clip } from "./text.js";
import { applyPatchPaths, readTurnContext, codexModes, fixModeFor } from "./codex.js";
import { discardQueue, repoRoot } from "./queue.js";

const L = C.limits;

export const CONSENT = "Intent Check is on. After a turn that changes source files, it sends your recent prompts, the diffs, the changed files and .intent/NOTES.md (if present) to the Intent Check service for a background review; obvious secrets are masked first. Each upload is listed in .intent/.sent.log. To turn it off: /intent:off";
const CONSENT_CONTEXT = "The Intent Check plugin is active: code changes are reviewed in the background, and concerns may arrive later as notes. The user can turn it off with /intent:off.";
export const connectLine = (url) => `Intent Check: connect your account → ${url}`;
const connectContext = (url) => `Intent Check is not connected yet, so nothing is being checked. If it comes up, the user can connect at ${url}`;
export const CONNECTED = "Intent Check: connected.";

export function isTaskNotification(prompt) {
  return typeof prompt === "string" && prompt.trimStart().startsWith("<task-notification>");
}

function isSubstantive(prompt) {
  const p = prompt.trim();
  return p.length >= 20 && !p.startsWith("/");
}

function out() {
  const user = [];
  const context = [];
  return {
    user, context,
    add(u, c) {
      if (u) user.push(u);
      if (c) context.push(c);
    },
    result() {
      return { user: user.join("\n"), context: context.join("\n\n") };
    },
  };
}

// Codex does not load plugin slash commands, so its users are told the other ways to turn it off.
export const CONSENT_CODEX = CONSENT.replace("To turn it off: /intent:off", "To turn it off: ask the agent to turn Intent Check off, or set INTENT_DISABLED=1");
const CONSENT_CONTEXT_CODEX = "The Intent Check plugin is active: code changes are reviewed in the background, and concerns may arrive later as notes. If the user wants it off, follow the intent-check skill (intent off), or they can set INTENT_DISABLED=1.";

function showConsentOnce(o, host = "claude-code") {
  const shown = withGlobal((gl) => {
    if (gl.consent_shown_at) return true;
    gl.consent_shown_at = new Date().toISOString();
    return false;
  });
  if (!shown) o.add(host === "codex" ? CONSENT_CODEX : CONSENT, host === "codex" ? CONSENT_CONTEXT_CODEX : CONSENT_CONTEXT);
}

// Connect-link UX: one line per session until connected, then "connected." once.
async function connectFlow(o, key, payload, { checkPending, host }) {
  if (apiKey().key) {
    if (takeConnectedAnnouncement()) o.add(CONNECTED, CONNECTED);
    return;
  }
  if (checkPending) {
    const c = readConnect();
    if (c && c.status === "pending") {
      await checkConnectOnce();
      if (apiKey().key) {
        if (takeConnectedAnnouncement()) o.add(CONNECTED, CONNECTED);
        return;
      }
      ensurePoller();
    }
  }
  const already = withSession(key, (s) => {
    if (s.flags.connect_shown) return true;
    s.flags.connect_shown = Date.now();
    return false;
  });
  if (already) return;
  const url = await ensureConnectLink(host, hostVersion(payload.transcript_path));
  if (url) o.add(connectLine(url), connectContext(url));
  else withSession(key, (s) => { delete s.flags.connect_shown; }); // try again next prompt
}

async function deliverPending(o, key, host) {
  if (apiKey().key) await checkLatePending(key);
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
  await connectFlow(o, key, payload, { checkPending: false, host });
  await deliverPending(o, key, host);
  return o.result();
}

async function captureBaseline(cwd) {
  const repo = await g.toplevel(cwd);
  if (!repo) return null;
  const [base, untracked] = await Promise.all([g.captureBaseline(repo), g.listUntracked(repo)]);
  return { repo, sha: base.sha, head: base.head, untracked, at: Date.now() };
}

export async function prompt(payload, { host = "claude-code" } = {}) {
  if (disabledReason()) return { user: "", context: "" };
  ensureDataDir();
  const key = sessionKey(payload.session_id);
  const text = typeof payload.prompt === "string" ? payload.prompt : "";
  const notification = isTaskNotification(text);
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const basePromise = captureBaseline(cwd);
  const o = out();
  showConsentOnce(o, host);
  const connectPromise = connectFlow(o, key, payload, { checkPending: true, host });
  const [baseline] = await Promise.all([basePromise, connectPromise]);

  withSession(key, (s) => {
    if (!notification && text.trim() && !text.trim().startsWith("/intent:")) {
      s.prompts.push(clip(text, L.prompt_chars * 4));
      if (s.prompts.length > L.max_prompts) s.prompts.splice(0, s.prompts.length - L.max_prompts);
      if (!s.first_prompt && isSubstantive(text)) s.first_prompt = clip(text, L.prompt_chars * 4);
      s.prompt_count += 1;
      const id = payload.prompt_id || payload.turn_id; // Claude Code: prompt_id; Codex: turn_id
      s.turn_id = typeof id === "string" && id ? id : `turn-${s.prompt_count}`;
    }
    if (typeof payload.permission_mode === "string") s.permission_mode = payload.permission_mode;
    // If the last Stop never consumed its paths (interrupted turn), keep the older baseline so
    // the next Stop still sees those edits (security-guidance behaviour).
    const preserve = s.touched.length > 0 && s.baseline && s.baseline.sha;
    if (!preserve) s.baseline = baseline;
  });

  await deliverPending(o, key, host);
  return o.result();
}

const PATCH_LINES_CAP = 400;

export function postTool(payload) {
  if (disabledReason()) return;
  ensureDataDir();
  const key = sessionKey(payload.session_id);
  const tool = payload.tool_name;
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
      // Codex edits arrive as a patch; take its paths (Bash edits are caught by the git diff).
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
  await runStop(payload, { canWake: false, host: "codex", poll: false, codexModes: modes, fixMode: fixModeFor(modes), submitTimeoutMs: 8000, submitBudgetMs: 15000 });
  if (payload.stop_hook_active === true || !apiKey().key) return { exit: 0 };
  await checkLatePending(key);
  const n = drainNotes(key, { host: "codex", only: "concerns" });
  if (n.context) return { exit: 2, text: n.context };
  return { exit: 0 };
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

