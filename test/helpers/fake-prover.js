// A fake prover (node:http) implementing contract v1 for tests and local smoke runs.
// Standalone: node test/helpers/fake-prover.js [port]  -> prints its base URL; control via POST /_control.
import zlib from "node:zlib";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const TEST_KEY = "ic_" + "A".repeat(32) + "BBBBBB";

const id22 = () => crypto.randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 22);

export function createFakeProver(opts = {}) {
  const st = {
    key: TEST_KEY,
    scenario: "concerns", // "concerns" | "no_concerns" | "partial" | "failed" | "superseded"
    pollsBeforeDone: 1,
    submitStatus: null, // e.g. { status: 429, code: "spend_cap" }
    concern: null, // override the agent concern
    connectApproved: false,
    connectKeyTaken: false,
    jobs: new Map(),
    requests: [],
    ...opts,
  };
  let base = "";

  function json(res, status, body) {
    const b = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
    res.end(b);
  }

  function result(job) {
    const units = job.request.units;
    const first = units[0];
    const concerns = st.scenario === "concerns" ? [st.concern || {
      id: "c1", type: "intent_mismatch", severity: "high", path: first.path, line: 3, claim_id: "k1",
      title: "\"Never below zero\" does not hold when percent > 100",
      explanation: "With percent = 150 the result is negative.",
      fix_direction: "Clamp percent to 0..100, or clamp the result at 0.",
    }] : [];
    return {
      verdict: concerns.length ? "concerns" : "no_concerns",
      partial: st.scenario === "partial",
      checked_at: new Date(job.created).toISOString(),
      agent_concerns: concerns,
      units: units.map((u, i) => ({
        path: u.path,
        checked_sha256: u.sha256,
        verdict: i === 0 && concerns.length ? "concerns" : "no_concerns",
        artifacts: { "INTENT.md": `# ${u.path}\n`, "SPEC.k": "module SPEC\nendmodule\n", "SEMANTICS.k": "module SEM\nendmodule\n", "VERDICT.md": concerns.length && i === 0 ? "Concerns (1)\n" : "No concerns\n" },
        claims: [],
      })),
    };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      let body = null;
      const url = new URL(req.url, base);
      try {
        const raw = (url.pathname === "/v1/deepscans" && req.headers["content-encoding"] !== "identity" ? zlib.gunzipSync(rawBuf) : rawBuf).toString("utf8");
        body = raw ? JSON.parse(raw) : null;
      } catch { body = null; }
      st.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      const authed = req.headers.authorization === `Bearer ${st.key}` && !st.keyRevoked;

      if (req.method === "POST" && url.pathname === "/_control") {
        Object.assign(st, body || {});
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/_state") {
        return json(res, 200, { requests: st.requests.map((r) => ({ method: r.method, path: r.path })), jobs: [...st.jobs.keys()] });
      }
      if (req.method === "GET" && url.pathname === "/v1/me") {
        if (st.meStatus) return json(res, st.meStatus, { error: { code: "x", message: "x" } });
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        return json(res, 200, { handle: st.handle || "tester", machine_name: "test-box", key_last4: st.key.slice(-4), environment: "test" });
      }
      if (req.method === "DELETE" && url.pathname === "/v1/me/key") {
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        st.keyRevoked = true;
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && url.pathname === "/v1/connect") {
        if (st.connectStartStatus) return json(res, st.connectStartStatus, { error: { code: "unavailable", message: "x", reason: null } });
        st.connectCreated = (st.connectCreated || 0) + 1;
        st.connectKeyTaken = false;
        st.deviceCode = crypto.randomBytes(24).toString("hex").slice(0, 32);
        const body = { device_code: st.deviceCode, user_code: "KDRT-MWQX", verification_url: st.verifyUrl || `${base}/connect/KDRT-MWQX`, expires_in: 900, interval: 1 };
        if (st.connectStartDelayMs) return void setTimeout(() => json(res, 201, body), st.connectStartDelayMs);
        return json(res, 201, body);
      }
      const cm = url.pathname.match(/^\/v1\/connect\/([A-Za-z0-9]+)$/);
      if (req.method === "GET" && cm) {
        if (st.pollStatus) return json(res, st.pollStatus, { error: { code: "rate_limited", message: "x" } });
        if (cm[1] !== st.deviceCode) return json(res, 404, { error: { code: "not_found", message: "unknown" } });
        if (st.connectStatus) return json(res, 200, { status: st.connectStatus }); // "denied" | "expired" | "consumed"
        if (!st.connectApproved) return json(res, 200, { status: "pending" });
        if (st.connectKeyTaken) return json(res, 200, { status: "consumed" });
        st.connectKeyTaken = true;
        st.keyRevoked = false;
        const handle = st.handle || "tester";
        return json(res, 200, { status: "approved", api_key: st.key, handle, account: { handle } });
      }
      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        if (st.submitStatus) return json(res, st.submitStatus.status, { error: { code: st.submitStatus.code, message: "x", reason: null } });
        if (st.failPath && body && Array.isArray(body.units) && body.units.some((u) => u.path === st.failPath)) {
          return json(res, 500, { error: { code: "internal", message: "x", reason: null } });
        }
        // Idempotency-Key: a repeat returns the original job (contract README).
        const idem = req.headers["idempotency-key"];
        st.idem = st.idem || new Map();
        let job_id = idem && st.idem.get(idem);
        if (!job_id) {
          job_id = id22();
          // Server behavior: a job supersedes the session's unfinished jobs on overlapping
          // paths, whatever their mode, unless it is a per-edit job (per_edit: true).
          if (body && body.per_edit !== true && Array.isArray(body.units)) {
            const paths = new Set(body.units.map((u) => u.path));
            for (const j of st.jobs.values()) {
              if (!j.superseded && j.request && j.request.session_id === body.session_id && j.request.units.some((u) => paths.has(u.path))) j.superseded = true;
            }
          }
          st.jobs.set(job_id, { request: body, polls: 0, created: Date.now() });
          if (idem) st.idem.set(idem, job_id);
        }
        const reply = () => json(res, 202, { job_id, url: `${base}/r/${job_id}`, status: "queued" });
        if (st.submitDelayMs) return void setTimeout(reply, st.submitDelayMs);
        return reply();
      }
      // DeepScan. st.deepscan = { submit: [{status, code, reason, retryAfter}, ...] consumed one per POST,
      // statuses: [...] one per GET (last repeats), summary, error }.
      if (req.method === "POST" && url.pathname === "/v1/deepscans") {
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        const ds = (st.deepscan = st.deepscan || {});
        st.deepscanContentType = req.headers["content-type"];
        const fail = (ds.submit || []).shift();
        if (fail && fail.drop) return void req.socket.destroy();
        if (fail) {
          const b = JSON.stringify({ error: { code: fail.code || "x", message: fail.message || "x", reason: fail.reason || null } });
          res.writeHead(fail.status, { "content-type": "application/json", ...(fail.retryAfter ? { "retry-after": String(fail.retryAfter) } : {}) });
          return res.end(b);
        }
        const idem = req.headers["idempotency-key"];
        ds.idem = ds.idem || new Map();
        let job_id = idem && ds.idem.get(idem);
        if (!job_id) {
          job_id = id22();
          st.scans = st.scans || new Map();
          st.scans.set(job_id, { request: body, polls: 0 });
          if (idem) ds.idem.set(idem, job_id);
        }
        return json(res, 202, { job_id, url: ds.urlOverride || `${base}/r/${job_id}`, status: "queued", ...(ds.budget_s === null ? {} : { budget_s: ds.budget_s ?? 900 }) });
      }
      const dm = url.pathname.match(/^\/v1\/deepscans\/([A-Za-z0-9]+)$/);
      if (req.method === "GET" && dm) {
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        if ((st.deepscan || {}).getStatus) return json(res, st.deepscan.getStatus, { error: { code: "internal", message: "x", reason: null } });
        const scan = st.scans && st.scans.get(dm[1]);
        if (!scan) return json(res, 404, { error: { code: "not_found", message: "no scan" } });
        const ds = st.deepscan || {};
        const seq = ds.statuses || ["done"];
        const status = seq[Math.min(scan.polls++, seq.length - 1)];
        const out = { job_id: dm[1], status, stage: status, progress: { stage: status, hunters_done: 0, hunters_total: 14, elapsed_s: 1 }, url: `${base}/r/${dm[1]}`, ...(ds.getBudget_s === undefined ? { budget_s: ds.budget_s ?? 900 } : ds.getBudget_s === null ? {} : { budget_s: ds.getBudget_s }) };
        if (status === "done") out.summary = ds.summary || { counts: { CRITICAL: 0, HIGH: 1, MODERATE: 0, LOW: 0, MARGINAL: 0 }, cards: [{ id: "F1", criticality: "HIGH", title: "A discount above 100 percent makes the price negative", property: "Price is never negative.", cause: [{ path: "src/pricing.py", line: 3 }], repro_sketch: "Call apply_discount(1000, 150).", control: "apply_discount(1000, 100) returns 0." }], one_liners: [] };
        if (status === "failed") out.error = ds.error || { code: "budget_exceeded", message: "The scan ran out of time.", reason: "scan_budget" };
        return json(res, 200, out);
      }
      const jm = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9]+)$/);
      if (req.method === "GET" && jm) {
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        const job = st.jobs.get(jm[1]);
        if (!job) return json(res, 404, { error: { code: "not_found", message: "no job" } });
        const common = { job_id: jm[1], url: `${base}/r/${jm[1]}` };
        if (job.superseded && !job.finished) return json(res, 200, { ...common, status: "superseded" });
        if (job.polls++ < st.pollsBeforeDone) return json(res, 200, { ...common, status: job.polls === 1 ? "queued" : "running" });
        if (st.scenario === "failed") return json(res, 200, { ...common, status: "failed", error: { code: "pipeline_error", message: "x", reason: null } });
        if (st.scenario === "superseded") return json(res, 200, { ...common, status: "superseded" });
        job.finished = true;
        return json(res, 200, { ...common, status: "done", result: result(job) });
      }
      json(res, 404, { error: { code: "not_found", message: "no route" } });
    });
  });

  return {
    state: st,
    get url() { return base; },
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve(base);
      }));
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    deepscanUploads() {
      return st.requests.filter((r) => r.method === "POST" && r.path === "/v1/deepscans").map((r) => r.body);
    },
    jobRequests() {
      return st.requests.filter((r) => r.method === "POST" && r.path === "/v1/jobs").map((r) => r.body);
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fp = createFakeProver();
  fp.listen(Number(process.argv[2] || 0)).then((u) => console.log(u));
}
