// The repo's .intent/ folder: one unit folder per checked source file, written atomically.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic, writeJsonAtomic, mkdirp } from "./fsutil.js";
import { pluginVersion } from "./config.js";

export const README = `# .intent

This folder is written by Intent Check (the \`intent\` plugin for Claude Code and Codex).
Each source file that was checked has a folder here, named by its path from the repo root:

- \`INTENT.md\`: what the code is meant to do, with hidden assumptions made explicit
- \`SPEC.k\`: K-style claims about the code (best-effort, written by a model, not machine-checked)
- \`SEMANTICS.k\`: a small K-style rewrite-rule model of the code (same caveat)
- \`VERDICT.md\`: No concerns, or the concerns found
- \`meta.json\`: the file hash that was checked, when, and the report link

Do not edit these files by hand; the next check of a file updates its folder.

\`.sent.log\` lists every upload from this repo (paths, sizes, time, where to). It never holds file contents and is not committed.

## Not committing this folder

The folder is meant to be committed. To keep it out of git, add this line to your repo's \`.gitignore\`:

    .intent/

To stop checks altogether, run \`/intent:off\` (or set \`INTENT_DISABLED=1\` or \`DO_NOT_TRACK=1\`).
`;

// ".intent/<rel>/" for a repo-relative path; null for anything that could escape the folder.
export function unitDir(root, rel) {
  if (typeof rel !== "string" || !rel || rel.length > 1024) return null;
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  const parts = norm.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || /[\0\n\r]/.test(p))) return null;
  if (parts[0] === ".intent" || parts[0] === ".git") return null;
  return path.join(root, ".intent", ...parts);
}

export function ensureScaffold(root) {
  const dir = path.join(root, ".intent");
  let isLink = false;
  try { isLink = fs.lstatSync(dir).isSymbolicLink(); } catch { /* not there yet */ }
  if (isLink) throw new Error(".intent is a symlink");
  mkdirp(dir);
  const put = (name, content) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) writeAtomic(f, content);
  };
  put("README.md", README);
  // Keeps .intent/ out of ripgrep-based agent search while git still tracks it.
  put(".ignore", "*\n");
  put(".gitignore", ".sent.log\n.queue\n");
}

// Refuse to follow a symlink planted inside .intent/ out of the folder: the deepest existing
// ancestor of the unit folder must resolve inside .intent/.
function insideIntent(root, dir) {
  const base = fs.realpathSync(path.join(root, ".intent"));
  let p = dir;
  while (!fs.existsSync(p)) p = path.dirname(p);
  const real = fs.realpathSync(p);
  return real === base || real.startsWith(base + path.sep);
}

const ART = ["INTENT.md", "SPEC.k", "SEMANTICS.k", "VERDICT.md"];

// unit: contract UnitResult; job: { job_id, url }; result: JobResult.
export function writeUnit(root, unit, job, result) {
  const dir = unitDir(root, unit.path);
  // A late result for a repo that has since been deleted or moved must not recreate it.
  if (!dir || !fs.existsSync(root)) return false;
  ensureScaffold(root);
  if (!insideIntent(root, dir)) return false;
  mkdirp(dir);
  const a = unit.artifacts || {};
  for (const name of ART) {
    if (typeof a[name] === "string") writeAtomic(path.join(dir, name), a[name]);
  }
  writeJsonAtomic(path.join(dir, "meta.json"), {
    source_sha256: unit.checked_sha256,
    reviewed_at: result.checked_at,
    review_id: job.job_id,
    url: job.url,
    verdict: unit.verdict,
    partial: result.partial === true,
    versions: { plugin: pluginVersion(), contract: "1" },
  });
  return true;
}

// One JSON line per upload: paths, bytes, time, URL. Never contents.
export function appendSentLog(root, entry) {
  try {
    ensureScaffold(root);
    appendNoFollow(path.join(root, ".intent", ".sent.log"), JSON.stringify(entry) + "\n");
  } catch { /* read-only repo: skip */ }
}

// Append to a regular file only: a symlink planted at this path (say, to ~/.bashrc) is refused.
export function appendNoFollow(file, text) {
  try {
    if (!fs.lstatSync(file).isFile()) return false;
  } catch { /* does not exist yet */ }
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o644);
  try {
    if (!fs.fstatSync(fd).isFile()) return false;
    fs.writeSync(fd, text);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
