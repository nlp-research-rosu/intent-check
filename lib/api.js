// Calls to the prover API. HTTP helpers resolve failures. Task results are mapped to
// the shapes the rest of the plugin reads (status done|failed|superseded, snake_case fields).
import { requestJson, requestBinary } from "./http.js";
import { apiUrl, consoleUrl, pluginVersion, pollIntervalMs, C } from "./config.js";
import { sleep } from "./fsutil.js";
import crypto from "node:crypto";

const H = C.headers;

function baseHeaders(key) {
  const h = { [H.plugin_version]: pluginVersion(), "user-agent": `intent-plugin/${pluginVersion()}` };
  if (key) h[H.auth] = `Bearer ${key}`;
  const pipe = process.env.INTENT_PIPELINE;
  if (pipe === "llm" || pipe === "canned") h[H.pipeline_override] = pipe;
  return h;
}

// The prover's error body is { code, message, details? }.
function errorOf(res) {
  const e = res.json;
  return {
    status: res.status,
    code: (e && typeof e.code === "string" && e.code) || (res.status === 0 ? res.error || "network" : "http_" + res.status),
    reason: (e && e.details && typeof e.details.reason === "string" && e.details.reason) || null,
  };
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isTaskId = (s) => typeof s === "string" && TASK_ID.test(s);
export const reportUrl = (id) => `${consoleUrl()}/tasks/${id}`;
// A 403 ACCESS_NOT_APPROVED: the key is valid, the account waits for approval.
export const notApprovedText = () => `This account is not approved for Prover yet. Apply at ${consoleUrl()}/apply, then try again.`;

// queued|running stay; completed is done; cancelled as SUPERSEDED is superseded; every other end is failed.
// data_expired keeps the result it had.
function taskStatus(t) {
  if (t.status === "queued" || t.status === "running") return t.status;
  if (t.error && t.error.code === "SUPERSEDED" && !t.result) return "superseded"; // also once its data expired
  if (t.status === "completed" || (t.status === "data_expired" && t.result)) return t.result ? "done" : "failed";
  return "failed";
}

const taskError = (t) => ({ code: (t.error && typeof t.error.code === "string" && t.error.code) || String(t.status), message: (t.error && t.error.message) || "" });

// Wait only inside an explicitly invoked command, with the same retry delays as Prove.
export async function waitForTask(readTask, { intervalMs = pollIntervalMs(), onProgress = () => {} } = {}) {
  let failures = 0;
  for (;;) {
    const response = await readTask();
    if (!response.ok) {
      const retryable = (response.status === 0 && response.code !== "bad_response") || [408, 429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || failures === 3) return response;
      const delay = 1000 * 2 ** failures++;
      console.error(`Intent Prover: status request failed (${response.code}); retrying in ${delay / 1000}s (${failures}/3).`);
      await sleep(delay);
      continue;
    }
    failures = 0;
    const task = response.scan;
    if (task.status !== "queued" && task.status !== "running") return response;
    onProgress(response);
    await sleep(intervalMs);
  }
}

// Whether the service accepts the key: the cheapest authenticated read.
export async function checkKey(key, timeoutMs = 3000) {
  const res = await requestJson("GET", `${apiUrl()}/tasks?limit=1`, { headers: baseHeaders(key), timeoutMs });
  return res.status === 200 ? { ok: true } : { ok: false, ...errorOf(res) };
}

// Scan: the snapshot goes up as one gzip body; a 429 from the ingest limiter carries Retry-After.
// The timeout grows with the body: 60 s plus 20 s per MB, at most 5 minutes.
export const uploadTimeoutMs = (bytes) => Math.min(300000, 60000 + 20000 * Math.ceil(bytes / (1024 * 1024)));

export async function submitScan(key, gz, idempotencyKey, timeoutMs = uploadTimeoutMs(gz.length)) {
  const res = await requestBinary("POST", `${apiUrl()}/scan`, {
    headers: { ...baseHeaders(key), [H.idempotency_key]: idempotencyKey },
    body: gz,
    timeoutMs,
  });
  const j = res.json;
  if (res.status === 202 && j && isTaskId(j.id)) return { ok: true, job_id: j.id, url: reportUrl(j.id) };
  const ra = Number(res.headers && res.headers["retry-after"]);
  const m = res.json && res.json.message;
  return { ok: false, ...errorOf(res), message: typeof m === "string" ? m.slice(0, 300) : null, retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null };
}

export async function getScan(key, jobId, timeoutMs = 10000) {
  const res = await requestJson("GET", `${apiUrl()}/tasks/${encodeURIComponent(jobId)}`, { headers: baseHeaders(key), timeoutMs });
  const t = res.json;
  if (res.status !== 200) return { ok: false, ...errorOf(res) };
  if (!t || t.id !== jobId || t.kind !== "scan" || typeof t.status !== "string") return { ok: false, status: 0, code: "bad_response", reason: null };
  const status = taskStatus(t);
  const scan = { status, stage: t.status };
  const r = t.result;
  if (r) {
    scan.budget_s = r.budgetSeconds;
    if (status === "done") {
      scan.summary = {
        counts: r.counts,
        cards: (r.cards || []).map(({ reproSketch, ...c }) => ({ ...c, repro_sketch: reproSketch })),
        one_liners: r.oneLiners || [],
      };
    }
  }
  if (status === "failed") scan.error = taskError(t);
  return { ok: true, scan, task: t };
}

// Fetch only the final report named by this task, never its sandbox working files.
export async function getScanReport(key, task, timeoutMs = 10000) {
  if (task?.status === "data_expired") return { ok: false, status: 410, code: "TASK_FILES_EXPIRED" };
  const ref = task?.result?.report;
  if (!isTaskId(task?.id) || ref?.name !== "report.json" || ref.url !== `/tasks/${task.id}/artifacts/report.json`
    || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > 8 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(ref.sha256)) {
    return { ok: false, status: 400, code: "INVALID_REPORT_REFERENCE" };
  }
  const res = await requestJson("GET", `${apiUrl()}${ref.url}`, { headers: baseHeaders(key), timeoutMs, redirect: true });
  if (res.status !== 200) return { ok: false, ...errorOf(res) };
  if (Buffer.byteLength(res.text) !== ref.size || crypto.createHash("sha256").update(res.text).digest("hex") !== ref.sha256) {
    return { ok: false, status: 0, code: "REPORT_HASH_MISMATCH" };
  }
  const report = res.json;
  if (!report || !Number.isInteger(report.version) || !Array.isArray(report.cards) || !Array.isArray(report.one_liners) || !report.coverage) {
    return { ok: false, status: 400, code: "INVALID_REPORT" };
  }
  return { ok: true, text: res.text, ref };
}
