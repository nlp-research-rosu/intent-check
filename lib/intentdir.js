// Project evidence: canonical operations and isolated source-review generations.
import fs from "node:fs";
import path from "node:path";
import { writeAtomic, writeJsonAtomic, mkdirp } from "./fsutil.js";
import { pluginVersion } from "./config.js";
import { BRIEF } from "./requirements.js";

export const README = `# .intent

REQUIREMENTS.md is the directly editable project brief, initially just # Project requirements and empty Purpose, Expected behavior, Constraints, Out of scope and Open questions sections.
Use intent-check requirements add --input requirement.json and update REQ-001 --input requirement.json for structured records. Input contains statement, nonempty targets (path and optional function/method symbol), and optional reason; the CLI assigns sequential REQ-001-style IDs. Placement follows targets: one exact source file uses files/<source-path>/requirements.json; multiple files use files/requirements.json. Documents contain only schema_version: 1 and requirements; records contain id, statement, targets and optional reason. Update retains the ID and relocates the record if its target files change. The input file is transport, never a chosen store destination. JSON and Markdown are separate documents, not synchronized copies. Requirement statements are not check or proof evidence.
Example input (omit the assigned ID): {"statement":"Reject negative input prices.","targets":[{"path":"src/pricing.py","symbol":"calculate_total"}],"reason":"Negative prices are invalid."}

Canonical request.json/result.json records live in runs/<run-id>/. DeepScan saves report.json there too; supporting detail files remain remote.
Each file review writes files/<source-path>/checks/<run-id>/ with meta.json and only that run's returned artifacts:
- INTENT.md: interpreted intent and assumptions
- SPEC.k and VERIFICATION.k: claims and supporting definitions
- SEMANTICS.k: supplied model, when present
- REASONING.md: review reasoning, not formal proof
- VERDICT.md: concerns and review outcome

Check/DeepScan findings are LLM-reviewed, not formal proofs. Concrete run and validation success are not proof. Source freshness is separate from confidence; compare exact input hashes before reusing evidence.
All canonical formal bundles live in proofs/<attempt-id>/ with frozen inputs, SCOPE.md, PROOF.md and prove.sh. Results remain in runs/. Supporting inputs are not verified targets; trusted claims are assumptions. prove/sessions/ is ignored authoring scratch, not canonical evidence.

Do not edit generated results or frozen inputs. Every check generation stands alone; a partial review never borrows artifacts from an earlier check.
.queue/ is transient file-review scheduling, and .sent.log is a JSONL upload audit (paths, sizes, time and destination; never contents). Both are ignored by Git. .ignore keeps generated evidence out of ordinary agent searches.

Durable evidence is intended to be committed. To exclude the whole folder, add .intent/ to your repository's .gitignore.
To stop plugin checks use /intent:off, INTENT_DISABLED=1 or DO_NOT_TRACK=1.
`;

export function unitDir(root, rel) {
  if (typeof rel !== "string" || !rel || rel.length > 1024) return null;
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  const parts = norm.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[\0\n\r]/.test(p))) return null;
  if (parts[0] === ".intent" || parts[0] === ".git") return null;
  return path.join(root, ".intent", "files", ...parts);
}

export function ensureScaffold(root) {
  const dir = path.join(root, ".intent");
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error(".intent is a symlink");
  mkdirp(dir);
  for (const [name, text] of [["README.md", README], ["REQUIREMENTS.md", BRIEF], [".ignore", "*\n"], [".gitignore", ".sent.log\n.queue\n"]]) {
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
  const dir = path.join(base, "checks", job.job_id);
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
    result_ref: `runs/${job.job_id}/result.json`, url: job.url,
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
