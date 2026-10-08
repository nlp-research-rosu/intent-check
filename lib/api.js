// Calls to the prover API (contract v1). Every function resolves; nothing throws.
import { requestJson, requestBinary } from "./http.js";
import { apiUrl, pluginVersion, C } from "./config.js";

const H = C.headers;

function baseHeaders(key) {
  const h = { [H.plugin_version]: pluginVersion(), "user-agent": `intent-plugin/${pluginVersion()}` };
  if (key) h[H.auth] = `Bearer ${key}`;
  const pipe = process.env.INTENT_PIPELINE;
  if (pipe === "llm" || pipe === "canned") h[H.pipeline_override] = pipe;
  return h;
}

function errorOf(res) {
  const e = res.json && res.json.error;
  return {
    status: res.status,
    code: (e && typeof e.code === "string" && e.code) || (res.status === 0 ? res.error || "network" : "http_" + res.status),
    reason: (e && typeof e.reason === "string" && e.reason) || null,
  };
}

const JOB_ID = /^[A-Za-z0-9]{22}$/;

export function isHttpUrl(s) {
  if (typeof s !== "string" || s.length > 2048 || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// supersede: false asks the service to leave earlier queued/running jobs on the same paths alone
// (per-edit checks), via a header outside the contract constants.
export async function submitJob(key, body, idempotencyKey, timeoutMs = 20000, { supersede = true } = {}) {
  const res = await requestJson("POST", `${apiUrl()}/v1/jobs`, {
    headers: { ...baseHeaders(key), [H.idempotency_key]: idempotencyKey, ...(supersede ? {} : { "X-Intent-Supersede": "off" }) },
    body,
    timeoutMs,
  });
  const j = res.json;
  if ((res.status === 202 || res.status === 200 || res.status === 201) && j && JOB_ID.test(j.job_id) && isHttpUrl(j.url)) {
    return { ok: true, job_id: j.job_id, url: j.url };
  }
  return { ok: false, ...errorOf(res) };
}

export async function getJob(key, jobId, timeoutMs = 10000) {
  const res = await requestJson("GET", `${apiUrl()}/v1/jobs/${encodeURIComponent(jobId)}`, {
    headers: baseHeaders(key),
    timeoutMs,
  });
  const j = res.json;
  if (res.status === 200 && j && typeof j.status === "string") return { ok: true, job: j };
  return { ok: false, ...errorOf(res) };
}

// The link goes into text the user and the agent read: it must point at the service we talk to
// (same origin as the API URL) and stay short.
export function isOwnLink(u) {
  if (!isHttpUrl(u) || u.length > 300) return false;
  try { return new URL(u).origin === new URL(apiUrl()).origin; } catch { return false; }
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

// DELETE /v1/me/key: revoke the calling key (204). A key the service no longer knows (401) is
// as good as revoked.
export async function deleteMyKey(key, timeoutMs = 5000) {
  const res = await requestJson("DELETE", `${apiUrl()}/v1/me/key`, { headers: baseHeaders(key), timeoutMs });
  if (res.status === 204 || res.status === 200) return { ok: true, revoked: true };
  if (res.status === 401) return { ok: true, revoked: false };
  return { ok: false, ...errorOf(res) };
}

// DeepScan: the snapshot goes up as one gzip body; a 429 from the ingest limiter carries Retry-After.
// The timeout grows with the body: 60 s plus 20 s per MB, at most 5 minutes.
export const uploadTimeoutMs = (bytes) => Math.min(300000, 60000 + 20000 * Math.ceil(bytes / (1024 * 1024)));

export async function submitDeepscan(key, gz, idempotencyKey, timeoutMs = uploadTimeoutMs(gz.length)) {
  const res = await requestBinary("POST", `${apiUrl()}/v1/deepscans`, {
    headers: { ...baseHeaders(key), [H.idempotency_key]: idempotencyKey },
    body: gz,
    timeoutMs,
  });
  const j = res.json;
  if ((res.status === 202 || res.status === 200 || res.status === 201) && j && JOB_ID.test(j.job_id) && isOwnLink(j.url)) {
    return { ok: true, job_id: j.job_id, url: j.url };
  }
  const ra = Number(res.headers && res.headers["retry-after"]);
  const m = res.json && res.json.error && res.json.error.message;
  return { ok: false, ...errorOf(res), message: typeof m === "string" ? m.slice(0, 300) : null, retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null };
}

export async function getDeepscan(key, jobId, timeoutMs = 10000) {
  const res = await requestJson("GET", `${apiUrl()}/v1/deepscans/${encodeURIComponent(jobId)}`, {
    headers: baseHeaders(key),
    timeoutMs,
  });
  const j = res.json;
  if (res.status === 200 && j && typeof j.status === "string") return { ok: true, scan: j };
  return { ok: false, ...errorOf(res) };
}
