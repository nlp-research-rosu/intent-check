// Small filesystem helpers for explicit commands.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function mkdirp(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

// Write to a temp file in the same directory, then rename, so readers never see half a file.
export function writeAtomic(file, data, mode) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
    if (mode) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function writeJsonAtomic(file, obj, mode) {
  writeAtomic(file, JSON.stringify(obj, null, 2) + "\n", mode);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
