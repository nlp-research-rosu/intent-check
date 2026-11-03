// Durable DeepScan output: the final report and scan metadata, not the VM's workspace.
import fs from "node:fs";
import path from "node:path";
import { apiUrl } from "./config.js";
import { getDeepscanReport, isTaskId } from "./api.js";
import { ensureScaffold, insideIntent } from "./intentdir.js";
import { readJson, sha256, writeAtomic, writeJsonAtomic } from "./fsutil.js";
import { runDir } from "./store.js";

export function prepareDeepscanDirectory(root, id = null) {
  if (!fs.statSync(root).isDirectory() || (id !== null && !isTaskId(id))) throw new Error("Invalid DeepScan destination");
  ensureScaffold(root);
  const dir = id ? runDir(root, id) : path.join(root, ".intent", "runs");
  if (!insideIntent(root, dir)) throw new Error("DeepScan destination is outside .intent");
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
  return dir;
}

export function saveDeepscanMetadata(scan, task = null) {
  const dir = prepareDeepscanDirectory(scan.repo_root, scan.job_id);
  const previous = readJson(path.join(dir, "result.json"), {});
  const meta = {
    version: 1, operation: "deepscan", evidence_level: scan.status === "done" ? "llm_reviewed" : "unchecked", task_id: scan.job_id, url: scan.url, api_url: scan.api_url || apiUrl(),
    created_at: scan.created_at, updated_at: new Date().toISOString(), depth: scan.depth, scope: scan.scope,
    source: scan.source || previous.source || null,
    task: task ? {
      id: task.id, kind: task.kind, status: task.status,
      created_at: task.createdAt, started_at: task.startedAt, finished_at: task.finishedAt,
      files_expire_at: task.filesExpireAt, budget_s: task.result?.budgetSeconds,
      report: task.result?.report ? {
        name: task.result.report.name, url: task.result.report.url,
        size: task.result.report.size, sha256: task.result.report.sha256,
      } : null,
      error: task.error ? { code: task.error.code, message: task.error.message } : null,
    } : previous.task || null,
    status: scan.status,
    report: previous.report || { status: "pending" },
  };
  if (["failed", "superseded"].includes(scan.status) && meta.report.status !== "saved") meta.report = { status: "unavailable", reason: scan.error?.code || scan.status };
  if (["expired", "unavailable"].includes(scan.report_status) && meta.report.status !== "saved") meta.report = { status: scan.report_status, reason: scan.report_error || scan.error?.code || scan.status };
  const request = path.join(dir, "request.json");
  if (!fs.existsSync(request)) writeJsonAtomic(request, {
    version: 1, operation: "deepscan", trigger: "request", submitted_at: scan.created_at,
    scope: scan.scope, depth: scan.depth, source: scan.source, api_url: scan.api_url || apiUrl(),
    requirement_binding: scan.source?.requirement_binding,
  });
  writeJsonAtomic(path.join(dir, "result.json"), meta);
  return { dir, meta };
}

// An interrupted collection repeats the GET, not the scan. Atomic writes keep a partial
// download from replacing a saved report. A saved copy remains usable after server expiry.
export async function saveDeepscanReport(scan, key, task) {
  const { dir, meta } = saveDeepscanMetadata(scan, task);
  const ref = task?.result?.report;
  let saved;
  try { saved = fs.readFileSync(path.join(dir, "report.json")); } catch { /* not collected yet */ }
  if (saved && ref && saved.length === ref.size && sha256(saved) === ref.sha256) {
    meta.report = { status: "saved", size: ref.size, sha256: ref.sha256, saved_at: meta.report.saved_at || new Date().toISOString() };
  } else {
    const result = await getDeepscanReport(key, task);
    if (result.ok) {
      writeAtomic(path.join(dir, "report.json"), result.text);
      meta.report = { status: "saved", size: result.ref.size, sha256: result.ref.sha256, saved_at: new Date().toISOString() };
    } else {
      const status = result.status === 410 ? "expired" : [400, 404].includes(result.status) ? "unavailable" : "pending";
      meta.report = { status, reason: result.code };
    }
  }
  writeJsonAtomic(path.join(dir, "result.json"), meta);
  return meta.report;
}
