// Test harness: temp data dirs, throwaway git repos, and running bin/intent.js like Claude Code does.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = path.join(ROOT, "bin", "intent.js");
export const FIXTURES = path.join(ROOT, "test", "fixtures", "claude");

// A captured payload with its project dir rewritten to `dir`.
export function fixture(name, dir = "/work/proj", patch = {}) {
  const raw = fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8").split("/work/proj").join(dir);
  return { ...JSON.parse(raw), ...patch };
}

export function tmpdir(prefix = "intent-test-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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
  return { ...env, CLAUDE_PLUGIN_DATA: dataDir, INTENT_API_URL: apiUrl, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_ROOT: ROOT, INTENT_PER_EDIT: "0", ...extra };
}

// Run one hook like Claude Code: JSON on stdin, capture stdout/stderr/exit code.
export function runHook(event, payload, env, { timeoutMs = 60000, onSpawn } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BIN, event], { env, cwd: payload && payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : ROOT });
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

// Without a url: the old top-level api_key. With one: keys[url], the current format.
export function saveKey(dataDir, key, url = null) {
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = url ? { keys: { [url]: key } } : { api_key: key };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
}

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
