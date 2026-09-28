// Where things live and how the plugin is configured. Precedence for the API base:
// INTENT_API_URL, then config.json api_url, then the compiled default. For the key:
// INTENT_API_KEY, then config.json api_key.
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
  const d = process.env.CLAUDE_PLUGIN_DATA;
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

export function apiKey() {
  const env = process.env.INTENT_API_KEY;
  if (env && env.trim()) return { key: env.trim(), source: "env" };
  const k = readConfig().api_key;
  if (typeof k === "string" && k) return { key: k, source: "config" };
  return { key: null, source: null };
}

export function saveApiKey(key) {
  updateConfig((c) => { c.api_key = key; });
}

export function clearSavedApiKey(key) {
  updateConfig((c) => { if (!key || c.api_key === key) delete c.api_key; });
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
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* no transcript */ }
  return "unknown";
}

export function osName() {
  return String(process.platform).slice(0, 20);
}

export function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}
