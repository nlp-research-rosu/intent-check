// Test harness: isolated data, throwaway repositories and explicit plugin commands.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = path.join(ROOT, "bin", "intent.js");

// realpathSync.native: on Windows the temp dir can be a short name (C:\Users\RUNNER~1\...), which only
// the native call expands to the long form git and the plugin report.
export function tmpdir(prefix = "intent-test-") {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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
  return { ...env, CLAUDE_PLUGIN_DATA: dataDir, XDG_CONFIG_HOME: xdgDir(dataDir), INTENT_API_URL: apiUrl, INTENT_CONSOLE_URL: apiUrl, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_ROOT: ROOT, ...extra };
}

// Saves the key for one service URL.
// The credentials file lives under XDG_CONFIG_HOME; each test gets its own next to its data dir.
export const xdgDir = (dataDir) => path.join(dataDir, "xdg");
export const credentialsPath = (dataDir) => path.join(xdgDir(dataDir), "intent-check", "credentials.json");

export function saveKey(dataDir, key, url) {
  const file = credentialsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ keys: { [new URL(url).origin]: key } }), { mode: 0o600 });
}

export const savedKey = (dataDir, url) => {
  try { return JSON.parse(fs.readFileSync(credentialsPath(dataDir), "utf8")).keys[new URL(url).origin]; } catch { return undefined; }
};

// fs.symlinkSync that also works on Windows without the symlink privilege where it can: a link to a
// folder becomes a junction there (no privilege needed; lstat still reports a symbolic link).
export function symlink(target, linkPath) {
  let type;
  if (process.platform === "win32") {
    try { if (fs.statSync(path.resolve(path.dirname(linkPath), target)).isDirectory()) type = "junction"; } catch { /* a dangling link */ }
  }
  fs.symlinkSync(target, linkPath, type);
}

// False on Windows without Developer Mode or an elevated shell: a link to a file needs the privilege.
export const CAN_SYMLINK_FILES = (() => {
  if (process.platform !== "win32") return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
export const SKIP_FILE_SYMLINKS = CAN_SYMLINK_FILES ? false : "a symlink to a file needs Developer Mode or an elevated shell on Windows";

// Files holding keys or session data are written owner-only (mode 600). Windows has no permission bits
// (Node reports 666 for any writable file; the user profile's ACL does that job), so nothing to check there.
export function assertOwnerOnly(file, expected = 0o600) {
  if (process.platform === "win32") return;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== expected) throw new Error(`${file} has mode ${mode.toString(8)}, expected ${expected.toString(8)}`);
}

// Whether a checked-in file is executable. Windows has no executable bit on disk, so there the mode
// git recorded for the file is read instead (what a POSIX checkout will get).
export function isExecutable(file) {
  if (process.platform !== "win32") return (fs.statSync(file).mode & 0o111) !== 0;
  const out = execFileSync("git", ["ls-files", "-s", "--", path.basename(file)], { cwd: path.dirname(file), encoding: "utf8" });
  return out.startsWith("100755 ");
}
