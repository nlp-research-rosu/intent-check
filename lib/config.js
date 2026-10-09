// Where things live and how the plugin is configured. Precedence for the API base:
// INTENT_API_URL, then config.json api_url, then the compiled default. For the key:
// INTENT_API_KEY, then config.json keys[api_url] (or the old top-level api_key).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, mkdirp, withLock } from "./fsutil.js";

export const DEFAULT_API_URL = "https://web-staging-7e1c.up.railway.app";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(PLUGIN_ROOT, "bin", "intent.js");

export const C = readJson(path.join(PLUGIN_ROOT, "contract", "constants.json"));

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

// The key for the service in use. Keys are stored per service URL (config.json keys[api_url]).
// The old top-level api_key stays readable for one version: it counts for any service until
// GET /v1/me has said yes (promoted under that URL) or no (legacy_rejected) for it.
export function apiKey() {
  const env = process.env.INTENT_API_KEY;
  if (env && env.trim()) return { key: env.trim(), source: "env" };
  const c = readConfig();
  const k = c.keys && typeof c.keys === "object" ? c.keys[apiUrl()] : null;
  if (typeof k === "string" && k) return { key: k, source: "config" };
  const legacy = legacyKey(c);
  if (legacy) return { key: legacy, source: "config" };
  return { key: null, source: null };
}

// A legacy top-level api_key that has not been verified for the current service yet.
export function legacyKey(c = readConfig()) {
  const k = c.api_key;
  if (typeof k !== "string" || !k) return null;
  const url = apiUrl();
  if (c.keys && typeof c.keys === "object" && c.keys[url]) return null;
  if (Array.isArray(c.legacy_rejected) && c.legacy_rejected.includes(url)) return null;
  return k;
}

export function saveApiKey(key, url = apiUrl()) {
  updateConfig((c) => {
    if (!c.keys || typeof c.keys !== "object" || Array.isArray(c.keys)) c.keys = {};
    c.keys[url] = key;
  });
}

// Forget a saved key (all copies of it): the per-service entry and the legacy field.
export function clearSavedApiKey(key, url = apiUrl()) {
  updateConfig((c) => {
    if (c.keys && typeof c.keys === "object" && (!key || c.keys[url] === key)) delete c.keys[url];
    if (c.api_key && (!key || c.api_key === key)) delete c.api_key;
  });
}

// The legacy key answered 200 on /v1/me for this service: it now lives under keys[url].
export function promoteLegacyKey(url = apiUrl()) {
  updateConfig((c) => {
    if (typeof c.api_key !== "string" || !c.api_key) return;
    if (!c.keys || typeof c.keys !== "object" || Array.isArray(c.keys)) c.keys = {};
    if (!c.keys[url]) c.keys[url] = c.api_key;
    // The key now belongs to this service only; the old field must not be offered to another one.
    c.legacy_for = url;
    delete c.api_key;
  });
}

// The service does not know the legacy key: stop offering it for this URL.
export function rejectLegacyKey(url = apiUrl()) {
  updateConfig((c) => {
    const list = Array.isArray(c.legacy_rejected) ? c.legacy_rejected : [];
    if (!list.includes(url)) list.push(url);
    c.legacy_rejected = list.slice(-10);
  });
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

export const MODES = ["classic", "per-edit"];

// classic: one review per turn, at Stop. per-edit: every edit is checked as it happens.
// INTENT_MODE beats config.json "mode"; the old per_edit boolean (true/false) is read as
// per-edit/classic. The default is classic.
// INTENT_MODE as set: lower-cased and trimmed. Null when unset or empty.
export function envMode() {
  const e = (process.env.INTENT_MODE || "").trim().toLowerCase();
  return e || null;
}

export function mode() {
  const e = envMode();
  if (MODES.includes(e)) return e;
  const c = readConfig();
  if (MODES.includes(c.mode)) return c.mode;
  if (typeof c.per_edit === "boolean") return c.per_edit ? "per-edit" : "classic";
  return "classic";
}

export function perEditMode() {
  return mode() === "per-edit";
}

export function setMode(m) {
  updateConfig((c) => {
    c.mode = m;
    delete c.per_edit;
  });
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
