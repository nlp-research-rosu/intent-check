// A fake prover (node:http) implementing contract v1 for tests and local smoke runs.
// Standalone: node test/helpers/fake-prover.js [port]  -> prints its base URL; control via POST /_control.
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
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, base);
      st.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      const authed = req.headers.authorization === `Bearer ${st.key}`;

      if (req.method === "POST" && url.pathname === "/_control") {
        Object.assign(st, body || {});
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/_state") {
        return json(res, 200, { requests: st.requests.map((r) => ({ method: r.method, path: r.path })), jobs: [...st.jobs.keys()] });
      }
      if (req.method === "POST" && url.pathname === "/v1/connect") {
        st.deviceCode = crypto.randomBytes(24).toString("hex").slice(0, 32);
        return json(res, 201, { device_code: st.deviceCode, user_code: "KDRT-MWQX", verification_url: `${base}/connect/KDRT-MWQX`, expires_in: 900, interval: 1 });
      }
      const cm = url.pathname.match(/^\/v1\/connect\/([A-Za-z0-9]+)$/);
      if (req.method === "GET" && cm) {
        if (cm[1] !== st.deviceCode) return json(res, 404, { error: { code: "not_found", message: "unknown" } });
        if (!st.connectApproved) return json(res, 200, { status: "pending" });
        if (st.connectKeyTaken) return json(res, 200, { status: "consumed" });
        st.connectKeyTaken = true;
        return json(res, 200, { status: "approved", api_key: st.key, account: { handle: "tester" } });
      }
      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        if (st.submitStatus) return json(res, st.submitStatus.status, { error: { code: st.submitStatus.code, message: "x", reason: null } });
        if (st.failPath && body && Array.isArray(body.units) && body.units.some((u) => u.path === st.failPath)) {
          return json(res, 500, { error: { code: "internal", message: "x", reason: null } });
        }
        const job_id = id22();
        st.jobs.set(job_id, { request: body, polls: 0, created: Date.now() });
        return json(res, 202, { job_id, url: `${base}/r/${job_id}`, status: "queued" });
      }
      const jm = url.pathname.match(/^\/v1\/jobs\/([A-Za-z0-9]+)$/);
      if (req.method === "GET" && jm) {
        if (!authed) return json(res, 401, { error: { code: "unauthorized", message: "bad key" } });
        const job = st.jobs.get(jm[1]);
        if (!job) return json(res, 404, { error: { code: "not_found", message: "no job" } });
        const common = { job_id: jm[1], url: `${base}/r/${jm[1]}` };
        if (job.polls++ < st.pollsBeforeDone) return json(res, 200, { ...common, status: job.polls === 1 ? "queued" : "running" });
        if (st.scenario === "failed") return json(res, 200, { ...common, status: "failed", error: { code: "pipeline_error", message: "x", reason: null } });
        if (st.scenario === "superseded") return json(res, 200, { ...common, status: "superseded" });
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
    jobRequests() {
      return st.requests.filter((r) => r.method === "POST" && r.path === "/v1/jobs").map((r) => r.body);
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fp = createFakeProver();
  fp.listen(Number(process.argv[2] || 0)).then((u) => console.log(u));
}
