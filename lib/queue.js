// Review requests for named files: `intent deepscan <files>` (S5). Whole-repo and folder scans
// are the DeepScan proper (lib/deepscan.js).
// The CLI only writes a small file under the repo's .intent/.queue/ and returns: no network and
// no plugin env vars, so it also works from inside the Codex sandbox. The next Stop runner
// takes the queue and submits the requests, so edits and requests share one code path.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { neverUpload } from "./redact.js";
import { C, disabledReason, apiKey } from "./config.js";
import { ensureScaffold } from "./intentdir.js";
import { MAX_FILE_BYTES } from "./changes.js";
import { isPaused as isPausedKey } from "./pause.js";

const MAX_QUEUED = 10;
const SKIP_DIRS = new Set([".git", ".intent", "node_modules", "vendor", "dist", "build", "third_party", ".venv", "venv", "__pycache__"]);

// One root rule, used identically by the CLI, the Stop and the "off" discard: the git top level
// inside a git repo, else the current folder. (In a non-git project, run `intent deepscan` from the
// project root.)
export function repoRoot(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    const top = out.toString("utf8").trim();
    if (top) return fs.realpathSync(top);
  } catch { /* not a git repo */ }
  return fs.realpathSync(cwd);
}

// A Claude Code worktree-isolated subagent runs in <main>/.claude/worktrees/<name>. Its requests go
// in the main repo's queue (the parent's Stop drains that one), with the worktree kept alongside.
export function mainWorktree(top) {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: top, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    const common = fs.realpathSync(out.toString("utf8").trim());
    if (path.basename(common) !== ".git") return null;
    const main = path.dirname(common);
    return main !== top && isWorktreeOf(main, top) ? main : null;
  } catch {
    return null;
  }
}

export function isWorktreeOf(main, dir) {
  const rel = path.relative(path.join(main, ".claude", "worktrees"), dir);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function queueDir(root) {
  return path.join(root, ".intent", ".queue");
}

// Validate one requested path; returns { rel } or { error }.
export function checkPath(root, cwd, p) {
  const abs = path.resolve(cwd, p);
  let real;
  try { real = fs.realpathSync(abs); } catch { return { error: `${p}: not found` }; }
  const rel = path.relative(root, real).split(path.sep).join("/");
  if (!rel || rel.startsWith("../") || path.isAbsolute(rel)) return { error: `${p}: outside the repo` };
  if (rel.split("/").some((d) => SKIP_DIRS.has(d))) return { error: `${p}: vendored or generated` };
  if (neverUpload(rel)) return { error: `${p}: looks like a secrets file, never sent` };
  let st;
  try { st = fs.statSync(real); } catch { return { error: `${p}: not found` }; }
  if (!st.isFile()) return { error: `${p}: not a file` };
  if (st.size > MAX_FILE_BYTES) return { error: `${p}: larger than 1 MB` };
  return { rel };
}

// id and attempts are kept when a failed item is put back, so its Idempotency-Key stays the same
// (a job the server created but answered slowly is replayed, not duplicated) and retries are capped.
export function enqueue(root, mode, rels, { id: keepId = null, attempts = 0, worktree = null } = {}) {
  ensureScaffold(root);
  const dir = queueDir(root);
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(".intent/.queue is a symlink");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  const id = keepId && /^\d+-[0-9a-f]{8}$/.test(keepId) ? keepId : `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const file = path.join(dir, `${id}.json`);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644);
  try {
    fs.writeSync(fd, JSON.stringify({ mode, paths: rels, attempts, ...(worktree ? { worktree } : {}), at: new Date().toISOString() }) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return id;
}

// Take (read and delete) queued requests, oldest first. Anything odd is dropped.
// Drop queued requests without sending them (checks are off).
export function discardQueue(root) {
  return takeQueue(root).length;
}

export function takeQueue(root) {
  const dir = queueDir(root);
  let names;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return [];
    names = fs.readdirSync(dir).filter((n) => /^\d+-[0-9a-f]{8}\.json$/.test(n)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.slice(0, MAX_QUEUED)) {
    const file = path.join(dir, name);
    let item = null;
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && st.size < 64 * 1024) item = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { item = null; }
    try { fs.unlinkSync(file); } catch { continue; } // another runner took it
    if (!item || (item.mode !== "request") || !Array.isArray(item.paths)) continue;
    const max = C.limits.max_units_edit;
    const paths = [...new Set(item.paths.filter((p) => typeof p === "string"))].slice(0, max);
    const attempts = Number.isInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0;
    // Only a worktree of this repo (the CLI resolved it); anything else is dropped with the item.
    let worktree = null;
    if (typeof item.worktree === "string") {
      if (!isWorktreeOf(root, item.worktree)) continue;
      worktree = item.worktree;
    }
    if (paths.length) out.push({ mode: item.mode, paths, id: name.replace(/\.json$/, ""), attempts, ...(worktree ? { worktree } : {}) });
  }
  return out;
}

// Queue a review of these files (`intent deepscan <files>`): returns the one line the agent
// (and user) sees.
export function checkCommand(paths, cwd = process.cwd()) {
  // Say so now rather than queue something that would silently wait or upload later.
  if (disabledReason()) return "Intent Check is off, so nothing was queued. Turn it on with /intent:on, and unset INTENT_DISABLED / DO_NOT_TRACK if set.";
  const key = apiKey().key;
  if (!key) return "Intent Check is not connected yet, so nothing was queued. Your next prompt shows the link to connect.";
  if (isPausedKey(key)) return "Intent Check: checks are paused because the API key was not accepted (or the plugin is out of date), so nothing was queued.";
  const top = repoRoot(cwd);
  const main = mainWorktree(top);
  const root = top; // paths are checked and stored relative to the folder they live in
  const max = C.limits.max_units_edit;
  const ok = [];
  const errors = [];
  for (const p of paths) {
    const r = checkPath(root, cwd, p);
    if (r.error) errors.push(r.error);
    else if (!ok.includes(r.rel)) ok.push(r.rel);
  }
  if (ok.length > max) {
    errors.push(`only the first ${max} files are reviewed`);
    ok.length = max;
  }
  if (!ok.length) return `Intent Check: nothing to review (${errors.join("; ")}).`;
  enqueue(main || top, "request", ok, { worktree: main ? top : null });
  const skipped = errors.length ? ` Skipped: ${errors.join("; ")}.` : "";
  return `Intent Check: queued a review of ${ok.length} file${ok.length === 1 ? "" : "s"}; it runs in the background when this turn ends and the result arrives as a note.${skipped}`;
}
