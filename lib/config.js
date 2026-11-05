// Where things live and how the plugin is configured. Precedence for the API base:
// INTENT_API_URL, then shared config.toml, then the default. For the key:
// INTENT_API_KEY, then the credentials file shared with the intent-check CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readJson, mkdirp } from "./fsutil.js";

export const DEFAULT_API_URL = "https://prover.intentcomputing.org";
export const DEFAULT_CONSOLE_URL = "https://prover-console.intentcomputing.org";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const envUrl = (name) => (process.env[name] || "").trim();

// The Rust CLI owns TOML parsing. Cache its local `config` result, never credentials.
// Installation belongs to the onboarding skill.
let sharedCache = { sig: null, config: null };
function sharedSettings() {
  const file = path.join(path.dirname(credentialsFile()), "config.toml");
  let st;
  try { st = fs.statSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const sig = JSON.stringify([file, st.mtimeMs, st.size, process.env.PATH, dataDir(), envUrl("INTENT_API_URL"), envUrl("INTENT_CONSOLE_URL")]);
  if (sharedCache.sig !== sig) {
    try {
      const output = execFileSync("intent-check", ["config"], {
        encoding: "utf8", timeout: 2000, maxBuffer: 65536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const { config } = JSON.parse(output);
      if (typeof config?.server_url !== "string" || typeof config?.portal_url !== "string") throw new Error("invalid settings");
      sharedCache = { sig, config };
    } catch (e) {
      if (e.code === "ENOENT") throw Object.assign(new Error("install the global intent-check CLI using the onboarding skill"), { code: "INTENT_CLI_REQUIRED" });
      throw Object.assign(new Error("could not read shared settings; run intent-check config to check config.toml"), { code: "INTENT_CONFIG" });
    }
  }
  return sharedCache.config;
}

export function apiUrl() {
  const raw = envUrl("INTENT_API_URL") || (sharedSettings() || {}).server_url || DEFAULT_API_URL;
  return String(raw).trim().replace(/\/+$/, "");
}

// Where report links point: the console shows a task by its ID.
export function consoleUrl() {
  return String(envUrl("INTENT_CONSOLE_URL") || (sharedSettings() || {}).portal_url || DEFAULT_CONSOLE_URL).trim().replace(/\/+$/, "");
}

export function pollIntervalMs() {
  return ((sharedSettings() || {}).poll_interval_seconds || 10) * 1000;
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

// Environment opt-outs apply to plugin Scan commands.
export function disabledReason() {
  if (process.env.INTENT_DISABLED === "1") return "INTENT_DISABLED";
  if (process.env.DO_NOT_TRACK === "1") return "DO_NOT_TRACK";
  return null;
}

export function osName() {
  return String(process.platform).slice(0, 20);
}
