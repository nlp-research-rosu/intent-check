// Canonical operation manifests/results and exact submitted source inputs; no conversations.
import fs from "node:fs";
import path from "node:path";
import { ensureScaffold, insideIntent } from "./intentdir.js";
import { writeJsonAtomic, sha256 } from "./fsutil.js";

export function runDir(root, id) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error("Invalid run ID");
  ensureScaffold(root);
  const dir = path.join(root, ".intent", "logs", id);
  if (!insideIntent(root, dir)) throw new Error("Invalid run destination");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveCheckRequest(root, id, built, submittedAt) {
  const request = built.request;
  for (const unit of request.units) {
    const file = path.join(runDir(root, id), "inputs", "source", unit.path);
    if (!insideIntent(root, file)) throw new Error("Invalid input destination");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, unit.content);
    if (unit.prior) {
      const prior = path.join(runDir(root, id), "inputs", "prior", `${unit.path}.json`);
      fs.mkdirSync(path.dirname(prior), { recursive: true });
      writeJsonAtomic(prior, unit.prior);
    }
  }
  if (request.intent.notes) fs.writeFileSync(path.join(runDir(root, id), "inputs", "requirements.txt"), request.intent.notes);
  writeJsonAtomic(path.join(runDir(root, id), "request.json"), {
    version: 1, operation: "check", trigger: request.mode === "request" ? "request" : request.per_edit ? "edit" : "turn",
    submitted_at: submittedAt, host: request.host, session_id: request.session_id,
    partial: request.truncated, submitted_context_sha256: request.intent.notes ? sha256(request.intent.notes) : null,
    requirement_binding: built.requirements,
    sources: request.units.map((u) => ({ path: u.path, source_sha256: u.sha256, submitted_sha256: sha256(u.content),
      content_truncated: u.content_truncated, regions: u.regions || null })),
  });
}

export function saveCheckResult(root, job, status) {
  const bound = status.status === "done" && Array.isArray(status.result?.units) && status.result.units.every((u) => job.sent.some((s) => s.rel === u.path && s.sha256 === u.checked_sha256));
  writeJsonAtomic(path.join(runDir(root, job.job_id), "result.json"), {
    version: 1, operation: "check", status: status.status, result: status.result || null,
    error: status.error || null, bindings_valid: bound, evidence_level: bound ? "llm_reviewed" : "unchecked",
  });
}
