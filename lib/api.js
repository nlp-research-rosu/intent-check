// Calls to the prover API. Every function resolves; nothing throws. Task results are mapped to
// the shapes the rest of the plugin reads (status done|failed|superseded, snake_case fields).
import { requestJson, requestBinary } from "./http.js";
import { apiUrl, consoleUrl, pluginVersion, C } from "./config.js";
import { ART } from "./intentdir.js";

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
  return res.status === 200 && typeof res.text === "string" ? res.text : null;
}

// queued|running stay; completed is done; cancelled as SUPERSEDED is superseded; every other end is failed.
// data_expired keeps the result it had.
function taskStatus(t) {
  if (t.status === "queued" || t.status === "running") return t.status;
  if (t.status === "completed" || (t.status === "data_expired" && t.result)) return t.result ? "done" : "failed";
  if (t.status === "cancelled" && t.error && t.error.code === "SUPERSEDED") return "superseded";
  return "failed";
}

const taskError = (t) => ({ code: (t.error && typeof t.error.code === "string" && t.error.code) || String(t.status), message: (t.error && t.error.message) || "" });

async function checkResult(key, t, timeoutMs) {
  const r = t.result;
  // Artifacts are gone once the task's data expired.
  const fetchArtifacts = t.status === "completed";
  const units = await Promise.all((Array.isArray(r.units) ? r.units : []).map(async (u) => {
    const artifacts = {};
    const refs = fetchArtifacts && u.artifacts ? ART.filter((n) => u.artifacts[n]) : [];
    const texts = await Promise.all(refs.map((n) => getArtifact(key, u.artifacts[n], timeoutMs)));
    refs.forEach((n, i) => { if (texts[i] !== null) artifacts[n] = texts[i]; });
    return {
      path: u.path,
      checked_sha256: u.checkedSha256,
      verdict: snake(u.verdict),
      claims: (u.claims || []).map((c) => ({ id: c.id, function: c.function, status: snake(c.status) })),
      artifacts,
    };
  }));
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
  if (res.status !== 200) return { ok: false, ...errorOf(res) };
  if (!t || t.kind !== "intentCheck" || typeof t.status !== "string") return { ok: false, status: 0, code: "bad_response", reason: null };
  const status = taskStatus(t);
  const job = { status, url: reportUrl(jobId) };
  if (status === "done") job.result = await checkResult(key, t, Math.max(timeoutMs, 5000));
  if (status === "failed") job.error = taskError(t);
  return { ok: true, job };
}

// The link goes into text the user and the agent read: it must point at the service we talk to
// (the API or the console origin) and stay short.
export function isOwnLink(u) {
  if (!isHttpUrl(u) || u.length > 300) return false;
  try { return [apiUrl(), consoleUrl()].some((b) => new URL(u).origin === new URL(b).origin); } catch { return false; }
}

export async function startConnect(body, timeoutMs = 1500) {
  const res = await requestJson("POST", `${apiUrl()}/v1/connect`, { headers: baseHeaders(null), body, timeoutMs });
  const j = res.json;
  if ((res.status === 201 || res.status === 200) && j && /^[A-Za-z0-9]{32}$/.test(j.device_code) && isOwnLink(j.verification_url)) {
    return {
      ok: true,
      device_code: j.device_code,
      user_code: typeof j.user_code === "string" ? j.user_code : "",
      verification_url: j.verification_url,
      expires_in: Number.isFinite(j.expires_in) ? j.expires_in : C.polling.connect_expires_s,
      interval: Number.isFinite(j.interval) ? j.interval : C.polling.connect_interval_ms / 1000,
    };
  }
  return { ok: false, ...(res.status === 200 || res.status === 201 ? { status: 0, code: "bad_response", reason: null } : errorOf(res)) };
}

export async function pollConnect(deviceCode, timeoutMs = 5000) {
  const res = await requestJson("GET", `${apiUrl()}/v1/connect/${encodeURIComponent(deviceCode)}`, {
    headers: baseHeaders(null),
    timeoutMs,
  });
  const j = res.json;
  if (res.status === 200 && j && typeof j.status === "string") {
    const key = typeof j.api_key === "string" && new RegExp(C.api_key.regex).test(j.api_key) ? j.api_key : null;
    return { ok: true, status: j.status, api_key: key, handle: cleanHandle(j.handle) || cleanHandle(j.account && j.account.handle) };
  }
  return { ok: false, ...errorOf(res) };
}

// A handle goes into text the user and the agent read: a short token from a safe alphabet.
export function cleanHandle(h) {
  if (typeof h !== "string") return null;
  const t = h.replace(/[^A-Za-z0-9_.@+-]/g, "").slice(0, 60);
  return t || null;
}

// GET /v1/me: who the key belongs to.
export async function getMe(key, timeoutMs = 3000) {
  const res = await requestJson("GET", `${apiUrl()}/v1/me`, { headers: baseHeaders(key), timeoutMs });
  const j = res.json;
  if (res.status === 200 && j && typeof j.handle === "string") {
    const s = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 80) : null);
    return { ok: true, me: { handle: cleanHandle(j.handle), machine_name: s(j.machine_name), key_last4: s(j.key_last4), environment: s(j.environment) } };
  }
  return { ok: false, ...errorOf(res) };
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
  if (res.status !== 200) return { ok: false, ...errorOf(res) };
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
