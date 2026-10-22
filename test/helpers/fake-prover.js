// A fake prover (node:http) serving the prover API routes (see the prover repo's openapi.yaml) for tests and local smoke runs.
// Standalone: node test/helpers/fake-prover.js [port]  -> prints its base URL; control via POST /_control.
import zlib from "node:zlib";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const TEST_KEY = "ic_" + "A".repeat(32) + "BBBBBB";

const newId = () => crypto.randomUUID();
const ERR = { unauthorized: { code: "AUTHENTICATION_REQUIRED", message: "A valid Bearer API key is required." } };

export function createFakeProver(opts = {}) {
  const st = {
    key: TEST_KEY,
    scenario: "concerns", // "concerns" | "no_concerns" | "partial" | "failed" | "superseded" | "data_expired" (data_expired keeps the verdict, no artifacts)
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

  const ART_TEXT = { "INTENT.md": (u) => `# ${u.path}\n`, "SPEC.k": () => "module SPEC\nendmodule\n", "SEMANTICS.k": () => "module SEM\nendmodule\n", "VERDICT.md": (u, i, bad) => (bad ? "Concerns (1)\n" : "No concerns\n") };
  const artifactText = (job, i, name) => ART_TEXT[name](job.request.units[i], i, i === 0 && concernsOf(job).length > 0);

  function concernsOf(job) {
    return ["concerns", "data_expired"].includes(st.scenario) ? [st.concern || {
      id: "c1", type: "intentMismatch", severity: "high", path: job.request.units[0].path, line: 3, claimId: "k1",
      title: "\"Never below zero\" does not hold when percent > 100",
      explanation: "With percent = 150 the result is negative.",
      fixDirection: "Clamp percent to 0..100, or clamp the result at 0.",
    }] : [];
  }

  // An IntentCheckResult (openapi): every file links its artifacts by path under the API root.
  function result(id, job) {
    const concerns = concernsOf(job);
    return {
      verdict: concerns.length ? "concerns" : "noConcerns",
      partial: st.scenario === "partial",
      concerns,
      units: job.request.units.map((u, i) => ({
        path: u.path,
        checkedSha256: u.sha256,
        verdict: i === 0 && concerns.length ? "concerns" : "noConcerns",
        partial: false,
        claims: [],
        artifacts: Object.fromEntries(Object.keys(ART_TEXT).map((name) => {
          const text = artifactText(job, i, name);
          return [name, { name, size: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex"), url: `/tasks/${id}/artifacts/${i}/${name}` }];
        })),
      })),
    };
  }

  // A Task (openapi TaskBase plus kind and result).
  function task(id, kind, status, { result: res = null, error = null, created = Date.now() } = {}) {
    const end = ["queued", "running"].includes(status) ? null : new Date().toISOString();
    return {
      id, kind, status, semantics: null, createdAt: new Date(created).toISOString(), startedAt: status === "queued" ? null : new Date(created).toISOString(), finishedAt: end,
      timing: null, error, kept: false, filesExpireAt: null, result: res,
    };
  }

  const defaultSummary = () => ({
    depth: "fast",
    budgetSeconds: 900,
    counts: { CRITICAL: 0, HIGH: 1, MODERATE: 0, LOW: 0, MARGINAL: 0 },
    cards: [{ id: "F1", criticality: "HIGH", title: "A discount above 100 percent makes the price negative", property: "Price is never negative.", cause: [{ path: "src/pricing.py", line: 3 }], reproSketch: "Call apply_discount(1000, 150).", control: "apply_discount(1000, 100) returns 0." }],
    oneLiners: [],
    report: { name: "report.json", size: 2, sha256: "0".repeat(64), url: "/tasks/x/artifacts/report.json" },
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      let body = null;
      const url = new URL(req.url, base);
      try {
        const raw = (url.pathname === "/deepscans" && req.headers["content-encoding"] !== "identity" ? zlib.gunzipSync(rawBuf) : rawBuf).toString("utf8");
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
      // The signed link an artifact redirects to: no API key needed, and none must arrive.
      const fm = url.pathname.match(/^\/_files\/([^/]+)\/(\d+)\/([A-Za-z.]+)$/);
      if (req.method === "GET" && fm) {
        st.fileAuth = req.headers.authorization || null;
        const job = st.jobs.get(fm[1]);
        if (!job || !ART_TEXT[fm[3]]) return json(res, 404, { code: "NOT_FOUND", message: "x" });
        const t = artifactText(job, Number(fm[2]), fm[3]);
        res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(t) });
        return res.end(t);
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
      if (req.method === "POST" && url.pathname === "/intent-checks") {
        if (!authed) return json(res, 401, ERR.unauthorized);
        if (st.submitStatus) return json(res, st.submitStatus.status, { code: st.submitStatus.code, message: "x" });
        if (st.failPath && body && Array.isArray(body.units) && body.units.some((u) => u.path === st.failPath)) {
          return json(res, 500, { code: "INTERNAL_ERROR", message: "x" });
        }
        // Idempotency-Key: a repeat returns the original task.
        const idem = req.headers["idempotency-key"];
        st.idem = st.idem || new Map();
        let id = idem && st.idem.get(idem);
        if (!id) {
          id = newId();
          // Server behavior: a check supersedes the caller's unfinished checks of the same files
          // unless it is a per-edit check (per_edit: true).
          if (body && body.per_edit !== true && Array.isArray(body.units)) {
            const paths = new Set(body.units.map((u) => u.path));
            for (const j of st.jobs.values()) {
              if (!j.superseded && j.request && j.request.session_id === body.session_id && j.request.units.some((u) => paths.has(u.path))) j.superseded = true;
            }
          }
          st.jobs.set(id, { request: body, polls: 0, created: Date.now() });
          if (idem) st.idem.set(idem, id);
        }
        const reply = () => json(res, 202, { id, kind: "intentCheck", status: "queued", semantics: null, createdAt: new Date().toISOString() });
        if (st.submitDelayMs) return void setTimeout(reply, st.submitDelayMs);
        return reply();
      }
      // DeepScan. st.deepscan = { submit: [{status, code, reason, retryAfter}, ...] consumed one per POST,
      // statuses: [...] one per GET (last repeats; queued|running|done|failed|superseded), summary, error }.
      if (req.method === "POST" && url.pathname === "/deepscans") {
        if (!authed) return json(res, 401, ERR.unauthorized);
        const ds = (st.deepscan = st.deepscan || {});
        st.deepscanContentType = req.headers["content-type"];
        const fail = (ds.submit || []).shift();
        if (fail && fail.drop) return void req.socket.destroy();
        if (fail) {
          const b = JSON.stringify({ code: fail.code || "x", message: fail.message || "x", ...(fail.reason ? { details: { reason: fail.reason } } : {}) });
          res.writeHead(fail.status, { "content-type": "application/json", ...(fail.retryAfter ? { "retry-after": String(fail.retryAfter) } : {}) });
          return res.end(b);
        }
        const idem = req.headers["idempotency-key"];
        ds.idem = ds.idem || new Map();
        let id = idem && ds.idem.get(idem);
        if (!id) {
          id = newId();
          st.scans = st.scans || new Map();
          st.scans.set(id, { request: body, polls: 0 });
          if (idem) ds.idem.set(idem, id);
        }
        return json(res, 202, { id, kind: "deepscan", status: "queued", semantics: null, createdAt: new Date().toISOString() });
      }
      if (req.method === "GET" && url.pathname === "/tasks") {
        if (!authed) return json(res, 401, ERR.unauthorized);
        return json(res, 200, { tasks: [], hasMore: false });
      }
      // Artifacts answer 302 to a signed link on a host that wants no API key (here: this server's /_files).
      const am = url.pathname.match(/^\/tasks\/([^/]+)\/artifacts\/(\d+\/[A-Za-z.]+)$/);
      if (req.method === "GET" && am) {
        if (!authed) return json(res, 401, ERR.unauthorized);
        if (!st.jobs.has(am[1])) return json(res, 404, { code: "NOT_FOUND", message: "Task was not found." });
        res.writeHead(302, { location: `${base}/_files/${am[1]}/${am[2]}` });
        return res.end();
      }
      const tm = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (req.method === "GET" && tm) {
        if (!authed) return json(res, 401, ERR.unauthorized);
        const id = tm[1];
        const scan = st.scans && st.scans.get(id);
        if (scan) {
          const ds = st.deepscan || {};
          if (ds.getStatus) return json(res, ds.getStatus, { code: "INTERNAL_ERROR", message: "x" });
          const seq = ds.statuses || ["done"];
          const status = seq[Math.min(scan.polls++, seq.length - 1)];
          if (status === "queued" || status === "running") return json(res, 200, task(id, "deepscan", status));
          if (status === "superseded") return json(res, 200, task(id, "deepscan", "cancelled", { error: { code: "SUPERSEDED", message: "A newer scan replaced this one." } }));
          if (status === "failed") return json(res, 200, task(id, "deepscan", "failed", { error: ds.error || { code: "DEEPSCAN_FAILED", message: "The scan ran out of time." } }));
          const sum = ds.summary || defaultSummary();
          const budget = ds.getBudget_s === undefined ? ds.budget_s ?? 900 : ds.getBudget_s;
          const { budgetSeconds, ...rest } = sum;
          return json(res, 200, task(id, "deepscan", "completed", { result: { ...rest, ...(budget === null ? {} : { budgetSeconds: budget }) } }));
        }
        const job = st.jobs.get(id);
        if (!job) return json(res, 404, { code: "NOT_FOUND", message: "Task was not found." });
        const superseded = () => json(res, 200, task(id, "intentCheck", "cancelled", { error: { code: "SUPERSEDED", message: "A newer check replaced this one.", details: { supersededBy: newId() } } }));
        if (job.superseded && !job.finished) return superseded();
        if (job.polls++ < st.pollsBeforeDone) return json(res, 200, task(id, "intentCheck", job.polls === 1 ? "queued" : "running"));
        if (st.scenario === "failed") return json(res, 200, task(id, "intentCheck", "failed", { error: { code: st.failCode || "CHECK_FAILED", message: "x" } }));
        if (st.scenario === "superseded") return superseded();
        job.finished = true;
        return json(res, 200, task(id, "intentCheck", st.scenario === "data_expired" ? "data_expired" : "completed", { result: result(id, job), created: job.created }));
      }
      json(res, 404, { code: "NOT_FOUND", message: "no route" });
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
      return st.requests.filter((r) => r.method === "POST" && r.path === "/deepscans").map((r) => r.body);
    },
    jobRequests() {
      return st.requests.filter((r) => r.method === "POST" && r.path === "/intent-checks").map((r) => r.body);
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fp = createFakeProver();
  fp.listen(Number(process.argv[2] || 0)).then((u) => console.log(u));
}
