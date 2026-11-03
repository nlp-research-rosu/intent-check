// Test harness: temp data dirs, throwaway git repos, and the checkout-built native runtime.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = path.join(ROOT, "cli", "target", "debug", process.platform === "win32" ? "intent-check.exe" : "intent-check");
export const FIXTURES = path.join(ROOT, "test", "fixtures", "claude");

// Resolve assertions against the latest saved generation, not the removed mutable unit folder.
export function reviewPath(repo, source, artifact) {
  const dir = path.join(repo, ".intent", "files", source, "checks");
  try {
    const generations = fs.readdirSync(dir).map(id => ({ id, meta: JSON.parse(fs.readFileSync(path.join(dir, id, "meta.json"), "utf8")) }))
      .sort((a, b) => (b.meta.submitted_at || 0) - (a.meta.submitted_at || 0) || b.id.localeCompare(a.id));
    return path.join(dir, generations[0]?.id || "missing", ...(artifact ? [artifact] : []));
  } catch { return path.join(dir, "missing", ...(artifact ? [artifact] : [])); }
}

// Raw fixture JSON with its project dir rewritten to `dir`, escaped because a Windows path has backslashes.
export function rewriteProjectDir(raw, dir) {
  return raw.split("/work/proj").join(JSON.stringify(dir).slice(1, -1));
}

// A captured payload with its project dir rewritten to `dir`.
export function fixture(name, dir = "/work/proj", patch = {}) {
  const raw = rewriteProjectDir(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"), dir);
  return { ...JSON.parse(raw), ...patch };
}

// realpathSync.native: on Windows the temp dir can be a short name (C:\Users\RUNNER~1\...), which only
// the native call expands to the long form git and the plugin report.
export function tmpdir(prefix = "intent-test-") {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeRepo({ git = true, commit = true } = {}) {
  const dir = tmpdir("intent-repo-");
  if (git) {
    const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" });
    g("init", "-q");
    if (commit) {
      fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
      g("add", "-A");
      g("commit", "-qm", "init");
    }
    return { dir, git: g };
  }
  return { dir, git: null };
}

export function baseEnv(dataDir, apiUrl, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("INTENT_") || k.startsWith("CLAUDE_") || k === "DO_NOT_TRACK") delete env[k];
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const inheritedPath = pathKey ? env[pathKey] : "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  return { ...env, PATH: inheritedPath, CLAUDE_PLUGIN_DATA: dataDir, XDG_CONFIG_HOME: xdgDir(dataDir), INTENT_API_URL: apiUrl, INTENT_CONSOLE_URL: apiUrl, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_ROOT: ROOT, INTENT_LIVE: "0", ...extra };
}

// Run a native hook or public command: JSON on stdin, capture stdout/stderr/exit code.
export function runHook(event, payload, env, { timeoutMs = 60000, onSpawn, host = "claude-code", args: extraArgs = [] } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = ["on", "off", "live", "doctor", "review", "deepscan"].includes(event)
      ? [event, ...extraArgs]
      : ["__hook", "--host", host, event];
    const child = spawn(BIN, args, { env, cwd: payload && payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, json: parseFirstJson(stdout) });
    });
    if (onSpawn) onSpawn(child);
    child.stdin.end(payload === undefined ? "" : JSON.stringify(payload));
  });
}

export function parseFirstJson(stdout) {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("{")) {
      try { return JSON.parse(line); } catch { /* next */ }
    }
  }
  return null;
}

export function readSessionFiles(dataDir) {
  const dir = path.join(dataDir, "sessions");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  } catch {
    return [];
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 15000, stepMs = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

// Saves the key for one service URL (config.json keys[url]).
// The credentials file lives under XDG_CONFIG_HOME; each test gets its own next to its data dir.
export const xdgDir = (dataDir) => path.join(dataDir, "xdg");
export const credentialsPath = (dataDir) => path.join(xdgDir(dataDir), "intent-check", "credentials.json");

export function saveKey(dataDir, key, url) {
  const file = credentialsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ keys: { [new URL(url).origin]: key } }), { mode: 0o600 });
}

export const savedKey = (dataDir, url) => {
  try { return JSON.parse(fs.readFileSync(credentialsPath(dataDir), "utf8")).keys[new URL(url).origin]; } catch { return undefined; }
};

// global.json content for tests that are not about the first-run notices (consent, "ready").
export const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
export const QUIET_GLOBAL = JSON.stringify({ consent_shown_at: "x", ready_version: PLUGIN_VERSION });

// Pre-seed machine-wide state (global.json), e.g. the consent notice already shown.
export function seedGlobal(dataDir, obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, "global.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* none yet */ }
  fs.writeFileSync(f, JSON.stringify({ ...cur, ...obj }), { mode: 0o600 });
}

// Seed retained evidence for tests of subsequent capture; this does not exercise persistence.
export function seedReview(repo, unit, job, result) {
  const dir = path.join(repo, ".intent", "files", unit.path, "checks", job.job_id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(unit.artifacts)) fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ version: 1, path: unit.path, source_sha256: unit.checked_sha256, review_id: job.job_id, submitted_at: Date.now(), reviewed_at: result.checked_at, url: job.url, verdict: unit.verdict }));
}

export function seedPause(data, key, code, source = "file") {
  const id = createHash("sha256").update(`${key}\n${PLUGIN_VERSION}`).digest("hex").slice(0, 16);
  seedGlobal(data, { paused: { id, code, source, at: Date.now() } });
}

// fs.symlinkSync that also works on Windows without the symlink privilege where it can: a link to a
// folder becomes a junction there (no privilege needed; lstat still reports a symbolic link).
export function symlink(target, linkPath) {
  let type;
  if (process.platform === "win32") {
    try { if (fs.statSync(path.resolve(path.dirname(linkPath), target)).isDirectory()) type = "junction"; } catch { /* a dangling link */ }
  }
  fs.symlinkSync(target, linkPath, type);
}

// False on Windows without Developer Mode or an elevated shell: a link to a file needs the privilege.
export const CAN_SYMLINK_FILES = (() => {
  if (process.platform !== "win32") return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
export const SKIP_FILE_SYMLINKS = CAN_SYMLINK_FILES ? false : "a symlink to a file needs Developer Mode or an elevated shell on Windows";

// Files holding keys or session data are written owner-only (mode 600). Windows has no permission bits
// (Node reports 666 for any writable file; the user profile's ACL does that job), so nothing to check there.
export function assertOwnerOnly(file, expected = 0o600) {
  if (process.platform === "win32") return;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== expected) throw new Error(`${file} has mode ${mode.toString(8)}, expected ${expected.toString(8)}`);
}

// Whether a checked-in file is executable. Windows has no executable bit on disk, so there the mode
// git recorded for the file is read instead (what a POSIX checkout will get).
export function isExecutable(file) {
  if (process.platform !== "win32") return (fs.statSync(file).mode & 0o111) !== 0;
  const out = execFileSync("git", ["ls-files", "-s", "--", path.basename(file)], { cwd: path.dirname(file), encoding: "utf8" });
  return out.startsWith("100755 ");
}
