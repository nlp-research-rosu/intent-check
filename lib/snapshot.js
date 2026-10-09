// DeepScan snapshot: the repo's text files as one gzip'd JSON document { meta, files } (contract
// deepscan-v1). What goes in: `git ls-files -co --exclude-standard` (tracked plus untracked,
// not ignored), working-tree contents, every file redacted line-for-line. What stays out is
// recorded in meta.trimmed so the report's coverage section can say so.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { C, pluginVersion, osName } from "./config.js";
import * as g from "./git.js";
import { redact, neverUpload } from "./redact.js";
import { isTestPath, extOf } from "./filter.js";

const D = C.deepscan;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
// The trimmed list is capped below the contract's 20000 so the inflated document (files plus
// list) stays under max_inflated_bytes; JSON escaping makes the document larger than the text.
const MAX_TRIMMED = 5000;
const JSON_RESERVE = 1024 * 1024;
const REPO_PATH = /^(?![A-Za-z]:)(?!\/)(?!.*\\)(?!.*\u0000)(?!.*(^|\/)\.\.(\/|$))(?!.*\/\/)(?!.*\/$).+$/;

const VENDOR_DIRS = new Set(["node_modules", "vendor", "third_party", "dist", "build", "out", "target", ".venv", "venv", "bower_components"]);
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum", "uv.lock", "bun.lock", "bun.lockb", "Pipfile.lock", "mix.lock", "pubspec.lock", "Podfile.lock", "flake.lock", "npm-shrinkwrap.json", "packages.lock.json"]);
const DOC_CONFIG_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".csv", ".env", ".properties", ".lock"]);

// Why a path is left out by its name alone, or null. (.git never appears in ls-files.)
const SECRET_NAMES = [
  /^\.(envrc|npmrc|netrc|pypirc|git-credentials|pgpass|htpasswd)$/i,
  /\.(tfvars|jks|keystore|p8|p12|pfx|pem|key)$/i,
  /^secrets(\..*)?$/i,
  /^service[-_]account.*\.json$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
];

// Intent Check's own output (.intent/ sits at the git toplevel) is model-written, never project
// source; only the user's NOTES.md is context worth reading. Skipped without a trimmed entry, so a
// large .intent/ cannot crowd the coverage list.
export function isIntentOutput(rel) {
  return rel.startsWith(".intent/") && rel !== ".intent/NOTES.md";
}

export function pathReason(rel) {
  if (neverUpload(rel) || SECRET_NAMES.some((re) => re.test(rel.split("/").pop()))) return "secret";
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => VENDOR_DIRS.has(d))) return "vendored";
  if (LOCKFILES.has(base)) return "lockfile";
  if (/\.min\.[^/]+$/i.test(base) || /\.map$/i.test(base)) return "generated";
  return null;
}

// Trim priority when the snapshot is over a cap: source (0) before tests (1) before docs and
// config (2). Within a tier, shallower paths first, then alphabetical.
export function tierOf(rel) {
  if (isTestPath(rel)) return 1;
  if (DOC_CONFIG_EXT.has(extOf(rel))) return 2;
  return 0;
}

export function byPriority(a, b) {
  return tierOf(a) - tierOf(b) || a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0);
}

// "https://host/org/repo" for any git remote form, with credentials, port-for-ssh, query and
// ".git" removed; null for a local path or anything that is not a host URL.
export function normaliseRemote(raw) {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url || /\s/.test(url)) return null;
  let host;
  let rest;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!["http", "https", "ssh", "git", "git+ssh", "ssh+git"].includes(proto)) return null;
    const m = /^([^/]*)(\/.*)?$/.exec(scheme[2]);
    let auth = m[1];
    rest = m[2] || "";
    auth = auth.slice(auth.lastIndexOf("@") + 1); // userinfo (user, user:token) is dropped
    host = proto === "http" || proto === "https" ? auth : auth.replace(/:\d*$/, ""); // an ssh port is not a web port
  } else {
    // scp-like: [user@]host:path
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
    if (!m || /^[A-Za-z]$/.test(m[1])) return null; // a drive letter is a local path
    host = m[1];
    rest = "/" + m[2].replace(/^\/+/, "");
  }
  if (!host || /[@\s]/.test(host)) return null;
  rest = rest.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const out = `https://${host.toLowerCase()}${rest}`;
  return out.length <= 500 && /^https:\/\/[^@/\s]+(\/\S*)?$/.test(out) ? out : null;
}

// git with stdin (check-attr --stdin); resolves { ok, out } like git.git.
function gitStdin(cwd, args, input, timeoutMs = 30000) {
  return new Promise((resolve) => {
    try {
      const child = execFile("git", ["-c", "core.fsmonitor=false", ...args], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "buffer", env: GIT_ENV }, (err, stdout) => {
        resolve(err ? { ok: false, out: "" } : { ok: true, out: stdout.toString("utf8") });
      });
      child.stdin.on("error", () => { /* git exited early */ });
      child.stdin.end(input);
    } catch {
      resolve({ ok: false, out: "" });
    }
  });
}

// Paths marked linguist-generated or linguist-vendored in .gitattributes: Map(path -> reason).
export async function attrExcluded(root, rels) {
  const out = new Map();
  if (!rels.length) return out;
  const r = await gitStdin(root, ["check-attr", "-z", "--stdin", "linguist-generated", "linguist-vendored"], rels.join("\0") + "\0");
  if (!r.ok) return out;
  const f = r.out.split("\0");
  for (let i = 0; i + 2 < f.length; i += 3) {
    if (f[i + 2] === "set" || f[i + 2] === "true") out.set(f[i], f[i + 1] === "linguist-vendored" ? "vendored" : "generated");
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Text of a buffer, or null when it looks binary (a NUL in the first 8 KB) or is not valid UTF-8.
// The service rejects the whole upload for a NUL or an unpaired surrogate anywhere in a file.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const unstorable = (s) => s.includes("\0") || LONE_SURROGATE.test(s);

export function decodeText(buf) {
  if (buf.includes(0)) return null;
  let t;
  try { t = utf8.decode(buf); } catch { return null; }
  return unstorable(t) ? null : t;
}

const lineCount = (s) => s.split("\n").length;

async function repoMeta(root) {
  const [remote, head, branch, status] = await Promise.all([
    g.git(root, ["remote", "get-url", "origin"], { timeoutMs: 3000 }),
    g.revParseHead(root),
    g.git(root, ["symbolic-ref", "--short", "-q", "HEAD"], { timeoutMs: 3000 }),
    g.git(root, ["status", "--porcelain=v1"], { timeoutMs: 15000 }),
  ]);
  return {
    remote_url: remote.ok ? normaliseRemote(remote.out) : null,
    head_sha: head && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head) ? head : null,
    branch: branch.ok && branch.out.trim() ? branch.out.trim().slice(0, 255) : null,
    dirty: status.ok && status.out.trim().length > 0,
  };
}

// depth (fast, balanced or full) goes up at the top level next to meta; null leaves it out (the service reads balanced).
// Returns { ok: true, gz, meta, root, over_cap, redactions } or { ok: false, error } (one line).
export async function buildSnapshot({ cwd, scope = null, host = "claude-code", depth = null }) {
  const root = await g.toplevel(cwd);
  if (!root) return { ok: false, error: "DeepScan needs a git repository: run it from inside one." };
  let rootReal = root;
  try { rootReal = fs.realpathSync(root); } catch { /* use as is */ }

  let scopeRel = null;
  if (scope) {
    let real;
    try { real = fs.realpathSync(path.resolve(cwd, scope)); } catch { return { ok: false, error: `${scope}: not found, so nothing was scanned.` }; }
    const rel = path.relative(rootReal, real).split(path.sep).join("/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, error: `${scope}: outside the repo, so nothing was scanned.` };
    scopeRel = rel === "" ? null : rel;
  }

  const ls = await g.git(rootReal, ["ls-files", "-co", "--exclude-standard", "-z", ...(scopeRel ? ["--", `:(literal)${scopeRel}`] : [])], { timeoutMs: 30000, maxBuffer: 256 * 1024 * 1024 });
  if (!ls.ok) return { ok: false, error: "DeepScan could not list the repo's files with git." };

  const trimmed = [];
  let trimmedTotal = 0;
  const trim = (p, reason) => {
    trimmedTotal++;
    if (trimmed.length < MAX_TRIMMED) trimmed.push({ path: p, reason });
  };

  // 1. By name: secrets, vendored and generated paths, lockfiles, paths the contract cannot carry.
  const cand = [];
  for (const p of new Set(ls.out.split("\0").filter(Boolean))) {
    if (p.length > D.max_path_chars || !REPO_PATH.test(p)) continue; // the contract cannot carry this path, not even in the trimmed list
    if (isIntentOutput(p)) continue;
    const why = pathReason(p);
    if (why) trim(p, why);
    else cand.push(p);
  }
  // 2. By .gitattributes.
  const attrs = await attrExcluded(rootReal, cand);
  const ordered = cand.filter((p) => {
    if (attrs.has(p)) { trim(p, attrs.get(p)); return false; }
    return true;
  }).sort(byPriority);

  // 3. In priority order, read what fits under the caps. Reading stops once nothing more can fit.
  const files = [];
  let bytes = 0;
  let jsonBytes = 0;
  let redactions = 0;
  let overCap = 0;
  const jsonCap = D.max_inflated_bytes - JSON_RESERVE;
  for (const p of ordered) {
    if (files.length >= D.max_files || bytes >= D.max_text_bytes - 64) { trim(p, "over_cap"); overCap++; continue; }
    const abs = path.join(rootReal, p);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; } // tracked but deleted in the working tree
    if (!st.isFile()) { if (st.isSymbolicLink()) trim(p, "symlink"); continue; } // directories (submodules) are not files
    try { // a parent directory that is now a symlink can lead outside the repo
      const real = fs.realpathSync(abs);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) { trim(p, "symlink"); continue; }
    } catch { continue; }
    if (st.size > D.max_file_bytes) { trim(p, "too_large"); continue; }
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    const text = decodeText(buf);
    if (text === null) { trim(p, "binary"); continue; }
    if (!text.trim()) continue;
    const r = redact(text);
    if (unstorable(r.text)) { trim(p, "binary"); continue; }
    // Redaction keeps line numbers (file:line citations depend on it); a file that does not stays home.
    if (lineCount(r.text) !== lineCount(text)) { trim(p, "redaction_error"); continue; }
    const size = Buffer.byteLength(r.text);
    const cost = Buffer.byteLength(JSON.stringify({ path: p, content: r.text })) + 2;
    if (size > D.max_file_bytes || bytes + size > D.max_text_bytes || jsonBytes + cost > jsonCap) { trim(p, "over_cap"); overCap++; continue; }
    files.push({ path: p, content: r.text });
    bytes += size;
    jsonBytes += cost;
    redactions += r.count;
  }
  if (!files.length) return { ok: false, error: "DeepScan found no text files to scan here." };
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const meta = {
    contract_version: "1",
    host: host === "codex" ? "codex" : "claude-code",
    plugin_version: pluginVersion().slice(0, 40),
    os: osName(),
    ...(await repoMeta(rootReal)),
    scope: scopeRel,
    file_count: files.length,
    bytes,
    trimmed,
  };
  const gz = zlib.gzipSync(JSON.stringify({ meta, files, ...(depth ? { depth } : {}) }), { level: 6 });
  if (gz.length > D.max_upload_bytes) return { ok: false, error: "The snapshot is too large to upload even compressed. Narrow it with --scope <folder>." };
  return { ok: true, gz, meta, root: rootReal, over_cap: overCap, trimmed_total: trimmedTotal, redactions };
}
