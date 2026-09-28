// Local debug log in the plugin data dir. Never holds file contents, prompts or keys.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

const MAX_BYTES = 1024 * 1024;

export function log(event, fields = {}) {
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "intent.log");
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + ".1");
    } catch { /* first write */ }
    const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...fields });
    fs.appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch { /* logging must never break a hook */ }
}

export function errFields(e) {
  return { error: String((e && e.code) || (e && e.name) || "error"), message: String((e && e.message) || e).slice(0, 200) };
}
