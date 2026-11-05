// Explicit file Scan submission and collection. Never reads host sessions or old queues.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { C, dataDir, ensureDataDir, apiUrl } from "./config.js";
import { toplevel } from "./git.js";
import { neverUpload } from "./redact.js";
import { decodeText } from "./snapshot.js";
import { buildRequest } from "./payload.js";
import { submitJob, getJob, isTaskId, waitForTask } from "./api.js";
import { readJson, writeJsonAtomic, sha256 } from "./fsutil.js";
import { ensureScaffold, appendSentLog, writeUnit } from "./intentdir.js";
import { validConcerns, sanitize } from "./render.js";

export const fileScansDir = () => path.join(dataDir(), "file-scans");
const recordFile = (id) => path.join(fileScansDir(), `${id}.json`);
const SKIP_DIRS = new Set([".git", ".intent", "node_modules", "vendor", "dist", "build", "third_party", ".venv", "venv", "__pycache__"]);

export async function projectRoot(cwd) {
  return fs.realpathSync(await toplevel(cwd) || cwd);
}

export async function submitFiles(paths, { cwd, host, key, failureLine }) {
  const root = await projectRoot(cwd);
  const files = [];
  const skipped = [];
  for (const name of paths) {
    let real;
    try { real = fs.realpathSync(path.resolve(cwd, name)); } catch { skipped.push(`${name}: not found`); continue; }
    const rel = path.relative(root, real).split(path.sep).join("/");
    if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) { skipped.push(`${name}: outside the project`); continue; }
    if (rel.split("/").some((part) => SKIP_DIRS.has(part)) || neverUpload(rel)) { skipped.push(`${name}: excluded path`); continue; }
    if (files.some((file) => file.rel === rel)) continue;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > 1024 * 1024) { skipped.push(`${name}: not a file under 1 MB`); continue; }
    const buf = fs.readFileSync(real);
    const content = decodeText(buf);
    if (content === null) { skipped.push(`${name}: not UTF-8 text`); continue; }
    if (files.length >= C.limits.max_units_files) { skipped.push(`${name}: file limit reached`); continue; }
    files.push({ rel, buf, content });
  }
  if (!files.length) return `Intent Check: nothing to scan (${skipped.join("; ")}).`;
  const id = crypto.randomBytes(16).toString("hex");
  const built = buildRequest({ files, root, host, sessionHash: id, turnId: id });
  if (!built) return "Intent Check: the requested files exceed the upload limit; scan fewer or smaller files.";
  ensureScaffold(root);
  ensureDataDir();
  fs.mkdirSync(fileScansDir(), { recursive: true, mode: 0o700 });
  let result = await submitJob(key, built.request, id);
  if (!result.ok && result.status === 0) result = await submitJob(key, built.request, id);
  if (!result.ok) return `Intent Check: ${failureLine(result)}`;
  const scan = { job_id: result.job_id, url: result.url, repo_root: root, api_url: apiUrl(), created_at: new Date().toISOString(), status: "queued", sent: built.sent };
  writeJsonAtomic(recordFile(scan.job_id), scan, 0o600);
  appendSentLog(root, { at: scan.created_at, mode: "request", job_id: scan.job_id, url: scan.url, files: built.sent, redactions: built.redactions });
  console.error(`Intent Check: file Scan started on ${built.sent.length} file(s). Report: ${result.url}${built.truncated ? " Some files were left out to fit the upload limit." : ""}${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}\nWaiting for results. If interrupted, resume with deepscan collect ${scan.job_id}.`);
  return collectFiles(scan, key);
}

export function listFileScans() {
  try {
    return fs.readdirSync(fileScansDir()).filter((name) => isTaskId(name.slice(0, -5)) && name.endsWith(".json"))
      .map((name) => readJson(path.join(fileScansDir(), name), null)).filter((scan) => scan && isTaskId(scan.job_id) && Array.isArray(scan.sent));
  } catch { return []; }
}

export async function collectFiles(scan, key) {
  const response = await waitForTask(() => getJob(key, scan.job_id), { onProgress: ({ job }) => {
    if (scan.status !== job.status) console.error(`File Scan ${scan.job_id}: ${job.status} · ${scan.url}`);
    scan.status = job.status;
    writeJsonAtomic(recordFile(scan.job_id), scan, 0o600);
  } });
  if (!response.ok) throw new Error(`File Scan ${scan.job_id}: status unavailable (${response.code}). The task may still be running; resume with deepscan collect ${scan.job_id}. ${scan.url}`);
  const job = response.job;
  scan.status = job.status;
  if (job.status !== "done") {
    writeJsonAtomic(recordFile(scan.job_id), scan, 0o600);
    throw new Error(`File Scan ${scan.job_id}: ${job.status}${job.error?.message ? `: ${sanitize(job.error.message, 300, "title")}` : ""} · ${scan.url}`);
  }
  const result = job.result;
  const allowed = new Set(scan.sent.map((file) => file.rel));
  for (const unit of result.units) {
    if (allowed.has(unit.path) && !writeUnit(scan.repo_root, unit, scan, result)) throw new Error(`Could not save Scan evidence for ${unit.path}`);
  }
  const concerns = validConcerns(result, [...allowed]);
  const lines = [`File Scan finished: ${concerns.length ? `${concerns.length} concern(s)` : "no concerns"}${result.partial ? " (partial review)" : ""} · ${scan.url}`];
  for (const concern of concerns.slice(0, C.limits.max_agent_concerns_shown)) lines.push(`- ${concern.path}${concern.line ? `:${concern.line}` : ""}: ${concern.title}${concern.fix ? ` Suggested direction: ${concern.fix}` : ""}`);
  for (const file of scan.sent) {
    try { if (sha256(fs.readFileSync(path.join(scan.repo_root, file.rel))) === file.sha256) continue; } catch { /* changed or removed */ }
    lines.push(`${file.rel} has changed since submission; findings describe the submitted version.`);
  }
  writeJsonAtomic(recordFile(scan.job_id), scan, 0o600);
  return lines.join("\n");
}
