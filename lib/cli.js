// `intent prove`: make sure the intent-check CLI of this plugin's version is in <data>/bin and print its path.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { ensureDataDir, pluginVersion } from "./config.js";
import { mkdirp, sha256 } from "./fsutil.js";

const RELEASES = "https://github.com/nlp-research-rosu/intent-check/releases/download";
const HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const MAX_BYTES = 200 * 1024 * 1024;
const OS = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH = { arm64: "arm64", x64: "x64" };

export function assetName(platform = process.platform, arch = process.arch) {
  const os = OS[platform], cpu = ARCH[arch];
  if (!os || !cpu) throw new Error(`Intent Check: no intent-check CLI is published for ${platform}/${arch} (macOS, Linux and Windows on arm64 or x64).`);
  return `intent-check-${os}-${cpu}.${os === "windows" ? "zip" : "tar.gz"}`;
}

// INTENT_CLI_BASE_URL is for tests: a local server, so plain http is allowed for 127.0.0.1 only.
function baseUrl(version) {
  const o = process.env.INTENT_CLI_BASE_URL;
  if (!o) return `${RELEASES}/v${version}`;
  const u = new URL(o);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") throw new Error("INTENT_CLI_BASE_URL must be http://127.0.0.1:<port>");
  return o.replace(/\/$/, "");
}

function allowed(u, base) {
  if (u.protocol === "https:") return HOSTS.has(u.hostname);
  return u.protocol === "http:" && u.hostname === "127.0.0.1" && u.origin === new URL(base).origin;
}

function get(url, base, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!allowed(u, base)) return reject(new Error(`refusing to download from ${u.origin}`));
    const req = (u.protocol === "https:" ? https : http).get(u, { timeout: 60000 }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error("too many redirects"));
        let to;
        try { to = new URL(res.headers.location, u).href; } catch { return reject(new Error("bad redirect")); }
        return resolve(get(to, base, hops + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code} for ${u.pathname}`)); }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BYTES) return req.destroy(new Error("download too large"));
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function versionOf(bin) {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/).pop();
  } catch {
    return null;
  }
}

// INTENT_CLI_PATH (use this binary as is) and INTENT_CLI_BASE_URL (download from a local test server)
// are test and development overrides, not user settings.
// macOS and Linux tar read .tar.gz. On Windows the zip needs bsdtar from System32: Git Bash's GNU tar
// can come first on PATH, cannot read zip and takes C: for a remote host.
function extract(file, dir) {
  const opts = { stdio: "ignore", timeout: 60000 };
  if (process.platform !== "win32") return execFileSync("tar", ["-xf", file, "-C", dir], opts);
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (fs.existsSync(tar)) return execFileSync(tar, ["-xf", file, "-C", dir], opts);
  execFileSync("powershell", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $env:IC_ZIP -DestinationPath $env:IC_DIR"], { ...opts, env: { ...process.env, IC_ZIP: file, IC_DIR: dir } });
}

// The CLI of this plugin's version if it is already on disk, else null (INTENT_CLI_PATH wins). Never downloads.
export function cliOnDisk({ version = pluginVersion(), platform = process.platform } = {}) {
  const override = process.env.INTENT_CLI_PATH;
  if (override) {
    if (!path.isAbsolute(override) || !fs.statSync(override, { throwIfNoEntry: false })?.isFile()) throw new Error(`Intent Check: INTENT_CLI_PATH must be the absolute path of an existing file (${override}).`);
    return override;
  }
  const bin = path.join(ensureDataDir(), "bin", platform === "win32" ? "intent-check.exe" : "intent-check");
  return versionOf(bin) === version ? bin : null;
}

export async function proveCommand({ version = pluginVersion(), platform = process.platform, arch = process.arch } = {}) {
  const found = cliOnDisk({ version, platform });
  if (found) return found;
  const asset = assetName(platform, arch);
  const dir = path.join(ensureDataDir(), "bin");
  const bin = path.join(dir, platform === "win32" ? "intent-check.exe" : "intent-check");

  const base = baseUrl(version);
  let archive, sum;
  try {
    [archive, sum] = await Promise.all([get(`${base}/${asset}`, base), get(`${base}/${asset}.sha256`, base)]);
  } catch (e) {
    throw new Error(`Intent Check: could not download the intent-check CLI v${version} (${e.message}).`);
  }
  const want = (sum.toString("utf8").match(/\b[0-9a-f]{64}\b/i) || [""])[0].toLowerCase();
  if (!want || sha256(archive) !== want) throw new Error("Intent Check: the downloaded intent-check CLI does not match its sha256 checksum; nothing was installed.");

  mkdirp(dir, 0o700);
  const tmp = fs.mkdtempSync(path.join(dir, ".dl-"));
  try {
    const file = path.join(tmp, asset);
    fs.writeFileSync(file, archive);
    extract(file, tmp);
    const got = path.join(tmp, path.basename(bin));
    if (!fs.existsSync(got)) throw new Error(`${path.basename(bin)} is missing from ${asset}`);
    fs.chmodSync(got, 0o755);
    fs.renameSync(got, bin);
  } catch (e) {
    throw new Error(`Intent Check: could not unpack the intent-check CLI (${e.message}).`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}
