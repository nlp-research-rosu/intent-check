// Per-session state in ${CLAUDE_PLUGIN_DATA}/sessions/<hash>.json, plus a small machine-wide
// state file. Every read-modify-write goes through a lock file (ported from the
// security-guidance plugin's with_locked_state, Apache-2.0; see NOTICE).
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";
import { readJson, writeJsonAtomic, withLock, sha256 } from "./fsutil.js";

const STATE_TTL_MS = 30 * 24 * 3600 * 1000;

export function sessionKey(sessionId) {
  return sha256("intent-session:" + String(sessionId || "default")).slice(0, 32);
}

const sessionsDir = () => path.join(dataDir(), "sessions");
const sessionFile = (key) => path.join(sessionsDir(), `${key}.json`);
const sessionLock = (key) => path.join(sessionsDir(), `${key}.lock`);

export function emptySession() {
  return {
    v: 1,
    prompts: [],
    first_prompt: null,
    prompt_count: 0,
    turn_id: null,
    plan: null,
    todos: [],
    touched: [],
    patches: {},
    baseline: null,
    pending: [],
    owner: null,
    notes: [],
    wakes: [],
    woken: {},
    flags: {},
  };
}

function normalise(s) {
  const base = emptySession();
  if (!s || typeof s !== "object") return base;
  for (const [k, v] of Object.entries(base)) {
    const cur = s[k];
    if (v === null) {
      if (cur === undefined) s[k] = null;
    } else if (Array.isArray(v) ? !Array.isArray(cur) : typeof cur !== typeof v || cur === null || Array.isArray(cur)) {
      s[k] = v;
    }
  }
  return s;
}

export function loadSession(key) {
  return normalise(readJson(sessionFile(key)));
}

// Run fn(state) with exclusive access; state is saved after fn returns.
export function withSession(key, fn) {
  return withLock(sessionLock(key), () => {
    const s = loadSession(key);
    const out = fn(s);
    writeJsonAtomic(sessionFile(key), s, 0o600);
    return out;
  });
}

const globalFile = () => path.join(dataDir(), "global.json");
const globalLock = () => path.join(dataDir(), "global.lock");

export function loadGlobal() {
  const g = readJson(globalFile(), {});
  return g && typeof g === "object" ? g : {};
}

export function withGlobal(fn) {
  return withLock(globalLock(), () => {
    const g = loadGlobal();
    const out = fn(g);
    writeJsonAtomic(globalFile(), g, 0o600);
    return out;
  });
}

// Drop session files untouched for 30 days. Cheap; runs at SessionStart.
export function gcSessions(now = Date.now()) {
  try {
    for (const name of fs.readdirSync(sessionsDir())) {
      const p = path.join(sessionsDir(), name);
      try {
        if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.unlinkSync(p);
      } catch { /* raced */ }
    }
  } catch { /* no dir yet */ }
}
