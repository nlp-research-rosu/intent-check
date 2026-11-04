// Current source knowledge and immutable operation artifacts.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic, writeJsonAtomic, mkdirp } from "./fsutil.js";
import { pluginVersion } from "./config.js";
import { BRIEF } from "./requirements.js";
import { operationDir } from "./project-id.js";

export const README = fs.readFileSync(new URL("../intent-storage.md", import.meta.url), "utf8");

export function unitDir(root, rel) {
  if (typeof rel !== "string" || !rel || rel.length > 1024) return null;
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  const parts = norm.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[\0\n\r]/.test(p))) return null;
  if (parts[0] === ".intent" || parts[0] === ".git") return null;
  return path.join(root, ".intent", "source", ...parts);
}

export function ensureScaffold(root) {
  const dir = path.join(root, ".intent");
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(".intent is a symlink");
  mkdirp(dir);
  for (const [name, text] of [["README.md", README], ["REQUIREMENTS.md", BRIEF], [".ignore", "*\n"], [".gitignore", ".sent.log\n.queue\n.storage.lock\n"]]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) writeAtomic(file, text);
  }
}

export function insideIntent(root, dir) {
  const base = fs.realpathSync(path.join(root, ".intent"));
  let p = dir;
  while (!fs.existsSync(p)) p = path.dirname(p);
  const real = fs.realpathSync(p);
  return real === base || real.startsWith(base + path.sep);
}

export const ART = ["INTENT.md", "SPEC.k", "SEMANTICS.k", "VERDICT.md", "VERIFICATION.k", "REASONING.md"];

export function writeUnit(root, unit, job, result) {
  const base = unitDir(root, unit.path);
  if (!base || !fs.existsSync(root) || !/^[A-Za-z0-9-]{1,128}$/.test(job.job_id)) return false;
  ensureScaffold(root);
  const operation = operationDir(root, job.job_id);
  const dir = path.join(operation, "artifacts", unit.path);
  if (!insideIntent(root, dir)) return false;
  mkdirp(dir);
  const artifacts = unit.artifacts || {};
  for (const name of ART) {
    const text = artifacts[name];
    if (typeof text === "string" && !(name === "SEMANTICS.k" && /^\s*\/\/\s*Not generated\b/.test(text))) writeAtomic(path.join(dir, name), text);
    else { try { fs.unlinkSync(path.join(dir, name)); } catch { /* absent */ } }
  }
  writeJsonAtomic(path.join(dir, "meta.json"), {
    version: 1, path: unit.path, source_sha256: unit.checked_sha256,
    reviewed_at: result.checked_at, review_id: job.job_id, submitted_at: job.submitted_at,
    result_ref: `logs/${path.basename(operation)}/result.json`, url: job.url,
    evidence_level: unit.partial === true ? "unchecked" : "llm_reviewed", verdict: unit.verdict,
    partial: unit.partial === true, task_partial: result.partial === true,
    claims: unit.claims || [], versions: { plugin: pluginVersion(), contract: "1" },
  });
  return true;
}

export function appendSentLog(root, entry) {
  try { ensureScaffold(root); appendNoFollow(path.join(root, ".intent", ".sent.log"), JSON.stringify(entry) + "\n"); } catch { /* read-only repo */ }
}

export function appendNoFollow(file, text) {
  try { const st = fs.lstatSync(file); if (!st.isFile() || st.nlink > 1) return false; } catch { /* absent */ }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o644);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return false;
    fs.writeSync(fd, text);
    return true;
  } finally { fs.closeSync(fd); }
}
