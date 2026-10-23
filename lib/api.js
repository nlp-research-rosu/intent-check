// Calls to the prover API. Every function resolves; nothing throws. Task results are mapped to
// the shapes the rest of the plugin reads (status done|failed|superseded, snake_case fields).
import { requestJson, requestBinary } from "./http.js";
import { apiUrl, consoleUrl, pluginVersion, C } from "./config.js";
import { ART } from "./intentdir.js";
import { log } from "./log.js";
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
const ARTIFACT_URL = /^\/tasks\/[0-9a-f-]{36}\/artifacts\/(?:report\.json|[0-9]{1,3}\/[A-Za-z.]+)$/;
const snake = (v) => (typeof v === "string" ? v.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()) : v);

export function isHttpUrl(s) {
  if (typeof s !== "string" || s.length > 2048 || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function submitJob(key, body, idempotencyKey, timeoutMs = 20000) {
  const res = await requestJson("POST", `${apiUrl()}/intent-checks`, {
    headers: { ...baseHeaders(key), [H.idempotency_key]: idempotencyKey },
    body,
    timeoutMs,
  });
  const j = res.json;
  if (res.status === 202 && j && isTaskId(j.id)) return { ok: true, job_id: j.id, url: reportUrl(j.id) };
  return { ok: false, ...errorOf(res) };
}

// A file of a finished task. The API answers 302 to a signed link on another host; http.js
// follows it without the key. Null when anything is off.
async function getArtifact(key, ref, timeoutMs) {
  if (!ref || !ARTIFACT_URL.test(ref.url)) return null;
  const res = await requestJson("GET", `${apiUrl()}${ref.url}`, { headers: baseHeaders(key), timeoutMs, redirect: true });
  if (res.status !== 200 || typeof res.text !== "string") return null;
  // The link is not checked by the server: compare with the size and hash the task states.
  if (Buffer.byteLength(res.text) !== ref.size || crypto.createHash("sha256").update(res.text).digest("hex") !== ref.sha256) {
    log("artifact.mismatch", { name: ref.name });
    return null;
  }
  return res.text;
}

// A task id the service answers 400 for (an old-format id kept in a session) is as dead as a 404.
const taskError404 = (res) => { const e = errorOf(res); return res.status === 400 ? { ...e, status: 404 } : e; };

// queued|running stay; completed is done; cancelled as SUPERSEDED is superseded; every other end is failed.
// data_expired keeps the result it had.
function taskStatus(t) {
  if (t.status === "queued" || t.status === "running") return t.status;
  if (t.error && t.error.code === "SUPERSEDED" && !t.result) return "superseded"; // also once its data expired
  if (t.status === "completed" || (t.status === "data_expired" && t.result)) return t.result ? "done" : "failed";
  return "failed";
}

const taskError = (t) => ({ code: (t.error && typeof t.error.code === "string" && t.error.code) || String(t.status), message: (t.error && t.error.message) || "" });

async function checkResult(key, t, timeoutMs) {
  const r = t.result;
  // Artifacts are gone once the task's data expired.
  const fetchArtifacts = t.status === "completed";
  let missing = false;
  const units = await Promise.all((Array.isArray(r.units) ? r.units : []).map(async (u) => {
    const artifacts = {};
    const refs = fetchArtifacts && u.artifacts ? ART.filter((n) => u.artifacts[n]) : [];
    const texts = await Promise.all(refs.map((n) => getArtifact(key, u.artifacts[n], timeoutMs)));
    refs.forEach((n, i) => { if (texts[i] !== null) artifacts[n] = texts[i]; else missing = true; });
    return {
      path: u.path,
      checked_sha256: u.checkedSha256,
      verdict: snake(u.verdict),
      claims: (u.claims || []).map((c) => ({ id: c.id, function: c.function, status: snake(c.status) })),
      artifacts,
    };
  }));
  // A unit written with some of its artifacts would sit next to stale ones from the last check.
  if (missing) return null;
  return {
    verdict: snake(r.verdict),
    partial: r.partial === true,
    checked_at: t.finishedAt,
    agent_concerns: (r.concerns || []).map((c) => ({
      id: c.id, type: snake(c.type), severity: c.severity, path: c.path, line: c.line, claim_id: c.claimId,
      title: c.title, explanation: c.explanation, fix_direction: c.fixDirection,
    })),
    units,
  };
}

export async function getJob(key, jobId, timeoutMs = 10000) {
  const res = await requestJson("GET", `${apiUrl()}/tasks/${encodeURIComponent(jobId)}`, { headers: baseHeaders(key), timeoutMs });
  const t = res.json;
  if (res.status !== 200) return { ok: false, ...taskError404(res) };
  if (!t || t.kind !== "intentCheck" || typeof t.status !== "string") return { ok: false, status: 0, code: "bad_response", reason: null };
  const status = taskStatus(t);
  const job = { status, url: reportUrl(jobId) };
  if (status === "done") {
    job.result = await checkResult(key, t, Math.max(timeoutMs, 5000));
    // Transient, so the runner polls again and refetches.
    if (!job.result) return { ok: false, status: 0, code: "artifact_fetch", reason: null };
  }
  if (status === "failed") job.error = taskError(t);
  return { ok: true, job };
}

// The link goes into text the user and the agent read: it must point at the service we talk to
// (the API or the console origin) and stay short.
export function isOwnLink(u) {
  if (!isHttpUrl(u) || u.length > 300) return false;
  try { return [apiUrl(), consoleUrl()].some((b) => new URL(u).origin === new URL(b).origin); } catch { return false; }
}

// Whether the service accepts the key: the cheapest authenticated read.
export async function checkKey(key, timeoutMs = 3000) {
  const res = await requestJson("GET", `${apiUrl()}/tasks?limit=1`, { headers: baseHeaders(key), timeoutMs });
  return res.status === 200 ? { ok: true } : { ok: false, ...errorOf(res) };
}

// DeepScan: the snapshot goes up as one gzip body; a 429 from the ingest limiter carries Retry-After.
// The timeout grows with the body: 60 s plus 20 s per MB, at most 5 minutes.
export const uploadTimeoutMs = (bytes) => Math.min(300000, 60000 + 20000 * Math.ceil(bytes / (1024 * 1024)));

export async function submitDeepscan(key, gz, idempotencyKey, timeoutMs = uploadTimeoutMs(gz.length)) {
  const res = await requestBinary("POST", `${apiUrl()}/deepscans`, {
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

export async function getDeepscan(key, jobId, timeoutMs = 10000) {
  const res = await requestJson("GET", `${apiUrl()}/tasks/${encodeURIComponent(jobId)}`, { headers: baseHeaders(key), timeoutMs });
  const t = res.json;
  if (res.status !== 200) return { ok: false, ...taskError404(res) };
  if (!t || t.kind !== "deepscan" || typeof t.status !== "string") return { ok: false, status: 0, code: "bad_response", reason: null };
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
  return { ok: true, scan };
}
