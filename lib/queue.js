// Review requests: `intent check <paths>` (S5) and `intent check --repo <paths>` (S6).
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
// inside a git repo, else the current folder. (In a non-git project, run `intent check` from the
// project root.)
export function repoRoot(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    const top = out.toString("utf8").trim();
    if (top) return fs.realpathSync(top);
  } catch { /* not a git repo */ }
  return fs.realpathSync(cwd);
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
export function enqueue(root, mode, rels, { id: keepId = null, attempts = 0 } = {}) {
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
    fs.writeSync(fd, JSON.stringify({ mode, paths: rels, attempts, at: new Date().toISOString() }) + "\n");
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
    if (!item || (item.mode !== "request" && item.mode !== "repo") || !Array.isArray(item.paths)) continue;
    const max = item.mode === "repo" ? C.limits.max_units_repo : C.limits.max_units_edit;
    const paths = [...new Set(item.paths.filter((p) => typeof p === "string"))].slice(0, max);
    const attempts = Number.isInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0;
    if (paths.length) out.push({ mode: item.mode, paths, id: name.replace(/\.json$/, ""), attempts });
  }
  return out;
}

// The CLI: returns the one line the agent (and user) sees.
export function checkCommand(args, cwd = process.cwd()) {
  const repo = args.includes("--repo");
  const paths = args.filter((a) => a !== "--repo" && !a.startsWith("--"));
  if (!paths.length) return "Intent Check: give the files to review, for example: intent check src/auth/login.py";
  // Say so now rather than queue something that would silently wait or upload later.
  if (disabledReason()) return "Intent Check is off, so nothing was queued. Turn it on with /intent:on (or unset INTENT_DISABLED / DO_NOT_TRACK).";
  const key = apiKey().key;
  if (!key) return "Intent Check is not connected yet, so nothing was queued. Your next prompt shows the link to connect.";
  if (isPausedKey(key)) return "Intent Check: checks are paused because the API key was not accepted (or the plugin is out of date), so nothing was queued.";
  const root = repoRoot(cwd);
  const max = repo ? C.limits.max_units_repo : C.limits.max_units_edit;
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
  enqueue(root, repo ? "repo" : "request", ok);
  const skipped = errors.length ? ` Skipped: ${errors.join("; ")}.` : "";
  return `Intent Check: queued a review of ${ok.length} file${ok.length === 1 ? "" : "s"}; it runs in the background when this turn ends and the result arrives as a note.${skipped}`;
}
