// Shadow snapshots: a baseline for projects that have no usable git baseline (not a git repo, or a
// repo with no commit yet). Candidate files are recorded into a private bare git dir under the
// plugin data folder (GIT_DIR=<data>/shadow/<hash of root>, GIT_WORK_TREE=<root>), so the project's
// own .git, index and stash are never touched. At prompt time the tree id is stored in the session;
// at Stop (or in the per-edit shell scan) the work tree is recorded again into a throwaway copy of
// the index and diffed against that tree. Every function resolves to null on a cap, a timeout or
// any git failure, and the caller then falls back to the touched-paths-only behaviour.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { git } from "./git.js";
import { dataDir } from "./config.js";
import { VENDOR_DIRS } from "./filter.js";
import { log } from "./log.js";

export const MAX_SHADOW_FILES = 3000;
export const WALK_BUDGET_MS = 1500;
const MAX_ENTRIES = 200000;
const PROMPT_BUDGET_MS = 3000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const LEAK_TTL_MS = 3600 * 1000;
const STOP_BUDGET_MS = 30000;
const GC_TTL_MS = 30 * 24 * 3600 * 1000;
// Never source, on top of filter.js's vendor dirs. Dot-directories are skipped wholesale.
const EXTRA_SKIP = new Set(["target", "out", "coverage", "env", "site-packages", "Pods", "obj", "bin-debug"]);

const shadowRoot = () => path.join(dataDir(), "shadow");

export function shadowDirFor(root) {
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* keep as given */ }
  return path.join(shadowRoot(), crypto.createHash("sha256").update(real).digest("hex").slice(0, 32));
}

// The home directory itself and filesystem/drive roots are never snapshotted.
export function rootAllowed(root) {
  try {
    const real = fs.realpathSync(root);
    if (path.parse(real).root === real) return false;
    const cmp = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
    for (const h of [os.homedir(), process.env.HOME, process.env.USERPROFILE]) {
      if (!h) continue;
      let hr = h;
      try { hr = fs.realpathSync(h); } catch { /* keep */ }
      if (cmp(hr) === cmp(real)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Candidate files under root as "/"-relative paths, or null when a cap or the time budget is hit.
export function walkCandidates(root, isCandidate, { maxFiles = MAX_SHADOW_FILES, budgetMs = WALK_BUDGET_MS, maxFileBytes = 1024 * 1024 } = {}) {
  const deadline = Date.now() + budgetMs;
  const out = [];
  const stack = [""];
  let seen = 0;
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    if (rel && entries.some((e) => e.name === ".git")) continue; // a nested repo is not this project's
    for (const e of entries) {
      if ((++seen & 255) === 0 && Date.now() > deadline) return null;
      if (seen > MAX_ENTRIES) return null;
      const name = e.name;
      const r = rel ? `${rel}/${name}` : name;
      if (e.isDirectory()) {
        if (name.startsWith(".") || VENDOR_DIRS.has(name) || EXTRA_SKIP.has(name)) continue;
        stack.push(r);
      } else if (e.isFile()) {
        if (!isCandidate(r)) continue;
        try { if (fs.statSync(path.join(root, r)).size > maxFileBytes) continue; } catch { continue; }
        if (out.length >= maxFiles) return null;
        out.push(r);
      }
    }
  }
  if (Date.now() > deadline) return null;
  return out.sort();
}

function envFor(dir, root, index) {
  return {
    GIT_DIR: dir, GIT_WORK_TREE: root, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1",
    // No user/system config: no clean-filter drivers (git-lfs and friends) run during add (git >= 2.32).
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.safecrlf", GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.attributesFile", GIT_CONFIG_VALUE_2: "",
  };
}

// Record the current candidate files into a copy of the persistent index and write a tree.
// persist: keep the updated index (its stat cache makes the next snapshot fast).
async function recordTree(root, isCandidate, { budgetMs, persist }) {
  const deadline = Date.now() + budgetMs;
  // Time left for one git call; 0 means the budget is spent.
  const left = (max) => Math.min(max, deadline - Date.now());
  const dir = shadowDirFor(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepLeaks(dir);
  const files = walkCandidates(root, isCandidate, { budgetMs: Math.min(WALK_BUDGET_MS, budgetMs) });
  if (!files) return null;
  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    if (left(5000) < 100) return null;
    const r = await git(root, ["init", "--bare", "-q", dir], { timeoutMs: left(5000) });
    if (!r.ok && !fs.existsSync(path.join(dir, "HEAD"))) { log("shadow.init_failed", {}); return null; }
  }
  const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const index = path.join(dir, `index.${tag}`);
  const lists = [path.join(dir, `paths.${tag}`), path.join(dir, `stale.${tag}`)];
  const env = envFor(dir, root, index);
  try {
    try { fs.copyFileSync(path.join(dir, "index"), index); } catch { /* first snapshot: empty index */ }
    if (files.length) {
      if (left(20000) < 100) return null;
      fs.writeFileSync(lists[0], files.join("\0") + "\0");
      // One unreadable file, or one deleted since the walk, fails the whole add: judged below.
      await git(root, ["add", "-f", "--ignore-errors", "--pathspec-from-file=" + lists[0], "--pathspec-file-nul"], { env, timeoutMs: left(20000) });
    }
    if (left(10000) < 100) return null;
    const ls = await git(root, ["ls-files", "-z"], { env, timeoutMs: left(10000), maxBuffer: 64 * 1024 * 1024 });
    if (!ls.ok) return null;
    const have = new Set(ls.out.split("\0").filter(Boolean));
    const want = new Set(files);
    // A candidate that is not in the index must be one that cannot be read now; anything else
    // means the add itself failed (timeout, git error) and the tree would be incomplete.
    for (const f of files) {
      if (have.has(f)) continue;
      try { fs.accessSync(path.join(root, f), fs.constants.R_OK); log("shadow.add_failed", {}); return null; } catch { want.delete(f); }
    }
    const stale = [...have].filter((p) => !want.has(p));
    if (stale.length) {
      if (left(10000) < 100) return null;
      fs.writeFileSync(lists[1], stale.join("\0") + "\0");
      const rm = await git(root, ["rm", "--cached", "-q", "-f", "--ignore-unmatch", "--pathspec-from-file=" + lists[1], "--pathspec-file-nul"], { env, timeoutMs: left(10000) });
      if (!rm.ok) return null;
    }
    if (left(10000) < 100) return null;
    const wt = await git(root, ["write-tree"], { env, timeoutMs: left(10000) });
    const tree = wt.ok ? wt.out.trim() : "";
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;
    if (persist) { try { fs.renameSync(index, path.join(dir, "index")); } catch { /* next time */ } }
    try { fs.writeFileSync(path.join(dir, "used"), String(Date.now())); } catch { /* gc hint only */ }
    return { dir, tree, count: files.length, files: want };
  } catch (e) {
    log("shadow.error", { message: String((e && e.message) || e).slice(0, 200) });
    return null;
  } finally {
    for (const f of [index, index + ".lock", ...lists]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  }
}

// Temp files a killed process (hook watchdog) left behind.
function sweepLeaks(dir) {
  try {
    const now = Date.now();
    for (const n of fs.readdirSync(dir)) {
      if (!/^(index\.|paths\.|stale\.)/.test(n)) continue;
      try { if (now - fs.statSync(path.join(dir, n)).mtimeMs > LEAK_TTL_MS) fs.unlinkSync(path.join(dir, n)); } catch { /* raced */ }
    }
  } catch { /* no dir */ }
}

// Prompt time. { dir, root, tree, at } or null (logged once); the caller keeps a null baseline.
export async function snapshot(root, isCandidate) {
  if (!rootAllowed(root)) { log("shadow.skipped", { reason: "root" }); return null; }
  // A recent failure (cap, budget, git) is not retried on every prompt.
  const failFile = path.join(shadowDirFor(root), "fail");
  try { if (Date.now() - fs.statSync(failFile).mtimeMs < FAIL_TTL_MS) return null; } catch { /* no marker */ }
  const t0 = Date.now();
  const r = await recordTree(root, isCandidate, { budgetMs: PROMPT_BUDGET_MS, persist: true });
  if (!r) {
    log("shadow.unavailable", { ms: Date.now() - t0 });
    try { fs.mkdirSync(path.dirname(failFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(failFile, String(Date.now())); } catch { /* best effort */ }
    return null;
  }
  try { fs.unlinkSync(failFile); } catch { /* none */ }
  log("shadow.snapshot", { files: r.count, ms: Date.now() - t0 });
  return { dir: r.dir, root, tree: r.tree, at: Date.now() };
}

// Files whose content differs from the baseline tree, plus new ones. Deleted files are listed apart.
// { changed: Map<rel, "A"|"M">, deleted: [rel], tree2, dir } or null.
export async function changedSince(sh, isCandidate) {
  if (!sh || !sh.root || !sh.dir || !/^[0-9a-f]{40,64}$/.test(sh.tree || "")) return null;
  if (!fs.existsSync(path.join(sh.dir, "HEAD"))) return null;
  const r = await recordTree(sh.root, isCandidate, { budgetMs: STOP_BUDGET_MS, persist: false });
  if (!r || r.dir !== sh.dir) return null;
  const env = envFor(sh.dir, sh.root, path.join(sh.dir, "index.unused"));
  const d = await git(sh.root, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", sh.tree, r.tree], { env, timeoutMs: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (!d.ok) return null;
  const bs = await git(sh.root, ["ls-tree", "-r", "--name-only", "-z", sh.tree], { env, timeoutMs: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (!bs.ok) return null;
  const parts = d.out.split("\0").filter((x) => x !== "");
  const changed = new Map();
  const deleted = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const st = parts[i][0];
    if (st === "D") deleted.push(parts[i + 1]);
    else changed.set(parts[i + 1], st === "A" ? "A" : "M");
  }
  return { changed, deleted, tree2: r.tree, dir: sh.dir, recorded: new Set([...bs.out.split("\0").filter(Boolean), ...r.files]) };
}

export async function diffFile(sh, tree2, rel) {
  const env = envFor(sh.dir, sh.root, path.join(sh.dir, "index.unused"));
  const r = await git(sh.root, ["diff-tree", "-p", "-r", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", sh.tree, tree2, "--", rel], { env, timeoutMs: 15000 });
  return r.ok ? r.out : null;
}

// Shadow dirs not used for 30 days.
export function gcShadows(now = Date.now()) {
  try {
    for (const name of fs.readdirSync(shadowRoot())) {
      const p = path.join(shadowRoot(), name);
      try {
        let m;
        try { m = fs.statSync(path.join(p, "used")).mtimeMs; } catch { m = fs.statSync(p).mtimeMs; }
        if (now - m > GC_TTL_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* raced */ }
    }
  } catch { /* no shadow dir yet */ }
}
