// Git helpers. Ported in spirit from the security-guidance plugin's gitutil/diffstate
// (Apache-2.0; see NOTICE): `git stash create` baseline at prompt time, diff against it at
// Stop, untracked snapshot so pre-existing untracked files are not re-reviewed.
// Every helper resolves to null/empty on failure and never touches the user's index or stash list.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"];
const UNTRACKED_CAP = 5000;

export function git(cwd, args, { timeoutMs = 5000, maxBuffer = 16 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve) => {
    try {
      execFile("git", [...GIT, ...args], {
        cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: "buffer",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
      }, (err, stdout) => {
        if (err) resolve({ ok: false, out: "" });
        else resolve({ ok: true, out: stdout.toString("utf8") });
      });
    } catch {
      resolve({ ok: false, out: "" });
    }
  });
}

// Git prints "C:/a/b" on Windows; path.resolve gives the form every other path here has ("C:\a\b").
const nativePath = (out) => (out ? path.resolve(out) : null);

export async function toplevel(cwd) {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 2000 });
  return r.ok ? nativePath(r.out.trim()) : null;
}

export async function commonDir(dir) {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 2000 });
  return r.ok ? nativePath(r.out.trim()) : null;
}

export async function revParseHead(repo) {
  const r = await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { timeoutMs: 2000 });
  return r.ok ? r.out.trim() || null : null;
}

// A commit object for the current working tree (HEAD when clean), built in a temporary index
// so the user's .git/index is never locked or rewritten. On any failure (no commit yet, broken
// index, a git error) the baseline is null and only the paths the agent touched are reviewed:
// falling back to HEAD would upload the user's own uncommitted work as the agent's change.
export async function captureBaseline(repo) {
  const head = await revParseHead(repo);
  if (!head) return { sha: null, head: null };
  const tmp = path.join(os.tmpdir(), `intent-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const env = {
    GIT_INDEX_FILE: tmp,
    GIT_AUTHOR_NAME: "intent-check", GIT_AUTHOR_EMAIL: "intent-check@localhost",
    GIT_COMMITTER_NAME: "intent-check", GIT_COMMITTER_EMAIL: "intent-check@localhost",
  };
  try {
    const ip = await git(repo, ["rev-parse", "--git-path", "index"], { timeoutMs: 2000 });
    const real = ip.ok ? path.resolve(repo, ip.out.trim()) : null;
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp);
    else if (!(await git(repo, ["read-tree", head], { env, timeoutMs: 5000 })).ok) return { sha: null, head };
    if (!(await git(repo, ["add", "-u"], { env, timeoutMs: 8000 })).ok) return { sha: null, head };
    const tree = await git(repo, ["write-tree"], { env, timeoutMs: 5000 });
    if (!tree.ok || !tree.out.trim()) return { sha: null, head };
    const headTree = await git(repo, ["rev-parse", `${head}^{tree}`], { timeoutMs: 2000 });
    if (headTree.ok && headTree.out.trim() === tree.out.trim()) return { sha: head, head };
    const c = await git(repo, ["commit-tree", tree.out.trim(), "-p", head, "-m", "intent-check baseline"], { env, timeoutMs: 5000 });
    return { sha: c.ok && c.out.trim() ? c.out.trim() : null, head };
  } catch {
    return { sha: null, head };
  } finally {
    for (const f of [tmp, tmp + ".lock"]) {
      try { fs.unlinkSync(f); } catch { /* not there */ }
    }
  }
}

export async function listUntracked(repo) {
  const r = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], { timeoutMs: 8000 });
  const out = {};
  if (!r.ok) return out;
  let n = 0;
  for (const p of r.out.split("\0")) {
    if (!p) continue;
    try { out[p] = fs.statSync(path.join(repo, p)).mtimeMs; } catch { out[p] = 0; }
    if (++n >= UNTRACKED_CAP) break;
  }
  return out;
}

export async function statusPorcelain(repo) {
  const r = await git(repo, ["status", "--porcelain=v1", "-uall", "-z"], { timeoutMs: 15000 });
  if (!r.ok) return null;
  const tracked = new Set();
  const untracked = new Set();
  const deleted = new Set();
  const renamed = [];
  const entries = r.out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (xy === "??") untracked.add(p);
    else {
      if (xy.includes("D")) deleted.add(p);
      else tracked.add(p);
      if (xy.includes("R") || xy.includes("C")) {
        if (xy.includes("R") && entries[i + 1]) renamed.push({ from: entries[i + 1], to: p });
        i++;
      }
    }
  }
  return { tracked, untracked, deleted, renamed };
}

export async function nameOnly(repo, base, range = false) {
  const r = await git(repo, ["diff", "--name-only", "-z", range ? `${base}..HEAD` : base], { timeoutMs: 15000 });
  if (!r.ok) return null;
  return new Set(r.out.split("\0").filter(Boolean));
}

export async function isAncestor(repo, a, b) {
  const r = await git(repo, ["merge-base", "--is-ancestor", a, b], { timeoutMs: 3000 });
  return r.ok;
}

export async function existsAt(repo, rev, rel) {
  const r = await git(repo, ["cat-file", "-e", `${rev}:${rel}`], { timeoutMs: 3000 });
  return r.ok;
}

export async function diffFile(repo, base, rel) {
  const r = await git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", base, "--", rel], { timeoutMs: 15000 });
  return r.ok ? r.out : null;
}

export async function ignored(repo, rels) {
  if (!rels.length) return new Set();
  // Exit 1 means "none ignored"; tracked files are never reported.
  const r = await git(repo, ["check-ignore", "-z", "--", ...rels], { timeoutMs: 3000 });
  return new Set(r.out.split("\0").filter(Boolean));
}
