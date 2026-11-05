// The repo's .intent/ folder: one unit folder per scanned source file, written atomically.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic, writeJsonAtomic, mkdirp } from "./fsutil.js";
import { pluginVersion } from "./config.js";

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

export const README = `# .intent

Project knowledge and evidence from explicitly requested Intent Check scans and proofs.
Commit this folder with the source; do not blanket-ignore it.

- prove/<target>/: proof inputs, scope and PROOF.md; prove/sessions/ is local CLI state.
- deepscan/<task-id>/: collected report.json and meta.json with source hashes and collection status.
- Source-path folders: collected INTENT.md, SPEC.k, VERIFICATION.k, REASONING.md, VERDICT.md and meta.json. Existing evidence is retained.
- NOTES.md: confirmed intended behaviour, included in later scans.

Scan commands wait for completion and save results. Use collect to resume an interrupted
Scan without resubmitting source. No automatic hooks or reviews run. Supporting DeepScan files remain remote.

Transient .queue, .sent.log and .storage.lock files are not committed.
The sent log records upload metadata, never source contents. Old queues are not consumed.
`;

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
  put(".gitignore", ".sent.log\n.queue\n.storage.lock\n");
}

// Refuse to follow a symlink planted inside .intent/ out of the folder: the deepest existing
// ancestor of the unit folder must resolve inside .intent/.
export function insideIntent(root, dir) {
  const base = fs.realpathSync(path.join(root, ".intent"));
  let p = dir;
  while (!fs.existsSync(p)) p = path.dirname(p);
  const real = fs.realpathSync(p);
  return real === base || real.startsWith(base + path.sep);
}

export const ART = ["INTENT.md", "SPEC.k", "SEMANTICS.k", "VERDICT.md", "VERIFICATION.k", "REASONING.md"];

function isStubSemantics(semantics) {
  return typeof semantics === "string" && /^\s*\/\/\s*Not generated\b/.test(semantics);
}

// unit: contract UnitResult; job: { job_id, url }; result: JobResult.
export function writeUnit(root, unit, job, result) {
  const dir = unitDir(root, unit.path);
  if (!dir || !fs.existsSync(root)) return false;
  ensureScaffold(root);
  if (!insideIntent(root, dir)) return false;
  mkdirp(dir);
  const a = unit.artifacts || {};
  for (const name of ART) {
    if (name === "SEMANTICS.k" && isStubSemantics(a[name])) {
      // A stub carries no behaviour; remove a previous non-stub rather than leave stale evidence.
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* not there */ }
      continue;
    }
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

// Append to a regular file only: a symlink planted at this path is refused.
export function appendNoFollow(file, text) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink > 1) return false;
  } catch { /* does not exist yet */ }
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o644);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return false;
    fs.writeSync(fd, text);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}
