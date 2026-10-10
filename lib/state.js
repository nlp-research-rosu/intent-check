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
    prompt_ids: [], // turn id of each entry in prompts (null when the payload had none)
    first_prompt: null,
    first_prompt_id: null,
    prompt_count: 0,
    turn_id: null,
    plan: null,
    todos: [],
    touched: [],
    patches: {},
    baseline: null,
    pending: [],
    edit_jobs: {},
    owner: null,
    notes: [],
    wakes: [],
    woken: {},
    flags: {},
  };
}

// The turn's view of the prompts: entries up to and including the last one recorded for turnId,
// so a prompt that arrived after this turn started is not judged against it. No/unknown id: all.
export function promptsUpTo(s, turnId) {
  const ids = s.prompt_ids || [];
  let n = s.prompts.length;
  if (turnId) for (let i = n - 1; i >= 0; i--) if (ids[i] === turnId) { n = i + 1; break; }
  const dropped = new Set(ids.slice(n, s.prompts.length).filter(Boolean));
  const first = s.first_prompt_id && dropped.has(s.first_prompt_id) ? null : s.first_prompt;
  return { prompts: s.prompts.slice(0, n), first_prompt: first, turn_id: turnId || s.turn_id };
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
  // Per-edit payload files whose child never ran.
  try {
    const tmp = path.join(dataDir(), "tmp");
    for (const name of fs.readdirSync(tmp)) {
      if (!/^edit-.*\.json$/.test(name)) continue;
      try {
        if (now - fs.statSync(path.join(tmp, name)).mtimeMs > 3600 * 1000) fs.unlinkSync(path.join(tmp, name));
      } catch { /* raced */ }
    }
  } catch { /* no tmp yet */ }
}
