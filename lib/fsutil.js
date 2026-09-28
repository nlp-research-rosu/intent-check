// Small filesystem helpers: JSON read, atomic write, a cross-platform lock file, sync sleep.
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

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exclusive lock via O_EXCL lock file. Node has no flock, so a lock older than
// staleMs is treated as abandoned (its holder crashed) and broken.
export function withLock(lockFile, fn, { waitMs = 2000, staleMs = 5000 } = {}) {
  mkdirp(path.dirname(lockFile));
  const deadline = Date.now() + waitMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > staleMs) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error("lock timeout");
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
