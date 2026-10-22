// Where things live and how the plugin is configured. Precedence for the API base:
// INTENT_API_URL, then config.json api_url, then the compiled default. For the key:
// INTENT_API_KEY, then the credentials file shared with the intent-check CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, mkdirp, withLock } from "./fsutil.js";

export const DEFAULT_API_URL = "https://prover.intentcomputing.org";
export const DEFAULT_CONSOLE_URL = "https://prover-console.intentcomputing.org";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(PLUGIN_ROOT, "bin", "hooks.js");

export const C = readJson(path.join(PLUGIN_ROOT, "lib", "constants.json"));

let versionCache = null;
export function pluginVersion() {
  if (versionCache) return versionCache;
  const pj = readJson(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), {});
  versionCache = typeof pj.version === "string" ? pj.version : "0.0.0";
  return versionCache;
}

export function dataDir() {
  const d = process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA;
  if (d) return d;
  return dataDirFromRoot(PLUGIN_ROOT) || path.join(os.homedir(), ".claude", "plugins", "data", "intent-intentcomputing");
}

// Run by hand or from a skill there is no plugin env. An installed plugin lives in
// <home>/plugins/cache/<marketplace>/<plugin>/<version> and keeps its data in
// <home>/plugins/data/<plugin>-<marketplace>, on Claude Code and Codex alike.
export function dataDirFromRoot(root) {
  const parts = path.resolve(root).split(path.sep);
  const i = parts.lastIndexOf("cache");
  if (i < 1 || parts[i - 1] !== "plugins" || parts.length !== i + 4) return null;
  return [...parts.slice(0, i), "data", `${parts[i + 2]}-${parts[i + 1]}`].join(path.sep);
}

export function ensureDataDir() {
  const d = dataDir();
  mkdirp(d, 0o700);
  return d;
}

const configFile = () => path.join(dataDir(), "config.json");
const configLock = () => path.join(dataDir(), "config.lock");

export function readConfig() {
  const c = readJson(configFile(), {});
  return c && typeof c === "object" ? c : {};
}

// Read-modify-write under a lock; always mode 600 because it can hold the API key.
export function updateConfig(fn) {
  ensureDataDir();
  return withLock(configLock(), () => {
    const c = readConfig();
    const out = fn(c);
    writeJsonAtomic(configFile(), c, 0o600);
    return out;
  });
}

export function apiUrl() {
  const env = process.env.INTENT_API_URL;
  const raw = env || readConfig().api_url || DEFAULT_API_URL;
  return String(raw).replace(/\/+$/, "");
}

// Where report links point: the console shows a task by its ID.
export function consoleUrl() {
  return String(process.env.INTENT_CONSOLE_URL || DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
}

// The credentials file the intent-check CLI shares: { "keys": { "<api origin>": "<key>" } }.
export function credentialsFile() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg ? path.join(xdg, "intent-check") : process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "intent-check") : path.join(os.homedir(), ".config", "intent-check");
  return path.join(dir, "credentials.json");
}

const apiOrigin = () => new URL(apiUrl()).origin;

// Throws on a file group or others can read (not on Windows), like the CLI. A missing file is empty.
function readCredentials(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { keys: {} }; }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("the credentials file is readable by others; run chmod 600 on it");
  const c = readJson(file, null);
  if (!c || typeof c !== "object" || !c.keys || typeof c.keys !== "object" || Array.isArray(c.keys) || !Object.values(c.keys).every((v) => typeof v === "string")) throw new Error("the credentials file is not valid");
  return c;
}

// The key for the service in use, stored per API origin.
export function apiKey() {
  const env = process.env.INTENT_API_KEY;
  if (env && env.trim()) return { key: env.trim(), source: "env" };
  try {
    const k = readCredentials(credentialsFile()).keys[apiOrigin()];
    if (typeof k === "string" && k) return { key: k, source: "file" };
  } catch { /* unreadable: no key, and doctor says why via credentialsProblem() */ }
  return { key: null, source: null };
}

// Every key this machine holds (environment and credentials file), for masking them in uploads.
// Keys are opaque, so they are matched by value, not by shape.
// Cached until the file or the environment key changes: redact() asks once per text.
let keysCache = { sig: null, keys: [] };
export function storedKeys() {
  const file = credentialsFile();
  const env = (process.env.INTENT_API_KEY || "").trim();
  let st = null;
  try { st = fs.statSync(file); } catch { /* no file */ }
  const sig = `${file}|${st ? `${st.mtimeMs}|${st.size}` : ""}|${env}`;
  if (keysCache.sig !== sig) {
    const out = env ? [env] : [];
    try { out.push(...Object.values(readCredentials(file).keys)); } catch { /* none readable */ }
    keysCache = { sig, keys: out.filter((k) => k.length >= 8) };
  }
  return keysCache.keys;
}

export function credentialsProblem() {
  try { readCredentials(credentialsFile()); return null; } catch (e) { return e.message; }
}

function updateCredentials(fn) {
  const file = credentialsFile();
  mkdirp(path.dirname(file), 0o700);
  return withLock(`${file}.lock`, () => {
    const c = readCredentials(file);
    fn(c.keys);
    writeJsonAtomic(file, c, 0o600);
  });
}

// Like the CLI: a key is only stored for an https service, or http on this machine.
export function saveApiKey(key) {
  const u = new URL(apiUrl());
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) throw new Error(`refusing to save a key for ${u.origin}: credentials need https, or http on localhost`);
  updateCredentials((keys) => { keys[apiOrigin()] = key; });
}

// Forget the saved key for this service.
export function clearSavedApiKey(key) {
  updateCredentials((keys) => { if (!key || keys[apiOrigin()] === key) delete keys[apiOrigin()]; });
}

// Any of these stops all uploads (and all hook work).
export function disabledReason() {
  if (process.env.INTENT_DISABLED === "1") return "INTENT_DISABLED";
  if (process.env.DO_NOT_TRACK === "1") return "DO_NOT_TRACK";
  if (readConfig().disabled === true) return "off";
  return null;
}

export function setDisabled(off) {
  updateConfig((c) => {
    if (off) c.disabled = true;
    else delete c.disabled;
  });
}

// Live review: every edit is checked as it happens, on top of the end-of-turn review that runs
// whenever Intent Check is on. INTENT_LIVE=1 or 0 beats config.json "live". The default is off.
export function envLive() {
  const e = (process.env.INTENT_LIVE || "").trim();
  return e === "1" ? true : e === "0" ? false : null;
}

export function liveMode() {
  const e = envLive();
  if (e !== null) return e;
  const c = readConfig();
  return c.live === true;
}

export function setLive(on) {
  updateConfig((c) => {
    c.live = !!on;
  });
}

// Where the host installed this plugin: <home>/plugins/cache/<marketplace>/<plugin>/<version>.
// Null when it runs from somewhere else (a checkout).
export function installInfo(root = PLUGIN_ROOT) {
  const parts = path.resolve(root).split(path.sep);
  const i = parts.lastIndexOf("cache");
  if (i < 1 || parts[i - 1] !== "plugins" || parts.length !== i + 4) return null;
  return { marketplace: parts[i + 1], plugin: parts[i + 2], version: parts[i + 3], versionsDir: parts.slice(0, i + 3).join(path.sep) };
}

// Claude Code does not pass its version to hooks, but every transcript line carries it.
export function hostVersion(transcriptPath) {
  if (process.env.CLAUDE_CODE_VERSION) return process.env.CLAUDE_CODE_VERSION.slice(0, 40);
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 65536);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const all = [...buf.toString("utf8").matchAll(/"version":"(\d+\.\d+\.\d+[^"]{0,20})"/g)];
      if (all.length) return all[all.length - 1][1].slice(0, 40);
      // Codex: the rollout's first line (session_meta) carries cli_version.
      const head = Buffer.alloc(Math.min(size, 4096));
      fs.readSync(fd, head, 0, head.length, 0);
      const cv = /"cli_version":"(\d+\.\d+\.\d+[^"]{0,20})"/.exec(head.toString("utf8"));
      if (cv) return cv[1].slice(0, 40);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* no transcript */ }
  return "unknown";
}

export function osName() {
  return String(process.platform).slice(0, 20);
}

// CLAUDE_CODE_ENTRYPOINT: these hosts never render Stop's asyncRewake (claude -p, the SDKs, a
// local-agent harness, MCP), so a Stop there is handed to a detached process instead (lib/hooks.js
// stop()) and its result can only ever become a note at the next prompt, never a wake. Everything
// else — the vscode/desktop/JetBrains extensions, remote sessions, an empty or unrecognised value
// — is interactive and takes the normal wake path.
const NON_INTERACTIVE_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py", "local-agent", "mcp"]);

export function isInteractiveEntrypoint(entrypoint) {
  return !NON_INTERACTIVE_ENTRYPOINTS.has(entrypoint);
}

export function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}
