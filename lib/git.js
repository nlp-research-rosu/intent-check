// Read-only Git queries for explicitly requested scans.
import { execFile } from "node:child_process";
import path from "node:path";

const GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false"];

export function git(cwd, args, { timeoutMs = 5000, maxBuffer = 16 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve) => {
    try {
      execFile("git", [...GIT, ...args], {
        cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: "buffer",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
      }, (err, stdout) => resolve(err ? { ok: false, out: "" } : { ok: true, out: stdout.toString("utf8") }));
    } catch { resolve({ ok: false, out: "" }); }
  });
}

export async function toplevel(cwd) {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 2000 });
  return r.ok ? path.resolve(r.out.trim()) : null;
}

export async function revParseHead(repo) {
  const r = await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { timeoutMs: 2000 });
  return r.ok ? r.out.trim() || null : null;
}
