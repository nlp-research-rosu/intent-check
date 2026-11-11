// A fake prover (node:http) serving the prover API routes (see the prover repo's openapi.yaml) for tests and local smoke runs.
// Standalone: node test/helpers/fake-prover.js [port]  -> prints its base URL; control via POST /_control.
import zlib from "node:zlib";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const TEST_KEY = "ak_test_" + "A".repeat(32); // Clerk keys are opaque: no format to rely on

const newId = () => crypto.randomUUID();
const ERR = { unauthorized: { code: "AUTHENTICATION_REQUIRED", message: "A valid Bearer API key is required." } };

export function createFakeProver(opts = {}) {
  const st = {
    key: TEST_KEY,
    minVersion: "0.1.0", // X-Intent-Version below this (or missing) gets 426
    connectApproved: false,
    connectKeyTaken: false,
    requests: [],
    ...opts,
  };
  let base = "";

  const vparts = (v) => String(v).split("-")[0].split(".").map(Number);
  const belowMin = (v) => {
    const a = /^\d+\.\d+\.\d+/.test(v || "") ? vparts(v) : null;
    const m = vparts(st.minVersion);
    return !a || [0, 1, 2].some((i) => { const d = a[i] - m[i]; return d !== 0 && [0, 1, 2].slice(0, i).every((j) => a[j] === m[j]) && d < 0; });
  };
  const upgrade = (res) => json(res, 426, { code: "UPGRADE_REQUIRED", message: `Intent Prover needs plugin version ${st.minVersion} or later. Update the plugin.`, details: { reason: "plugin_version" } });

  function json(res, status, body) {
    const b = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
    res.end(b);
  }

  // A Task (openapi TaskBase plus kind and result).
  function task(id, kind, status, { result: res = null, error = null, created = Date.now() } = {}) {
    const end = ["queued", "running"].includes(status) ? null : new Date().toISOString();
    return {
      id, kind, status, semantics: null, createdAt: new Date(created).toISOString(), startedAt: status === "queued" ? null : new Date(created).toISOString(), finishedAt: end,
      timing: null, error, kept: false, filesExpireAt: null, result: res,
    };
  }

  const reportText = JSON.stringify({ version: 1, cards: [], one_liners: [], coverage: {} });
  const defaultSummary = (depth, id) => ({
    depth,
    budgetSeconds: depth === "fast" ? 1800 : 3600,
    counts: { CRITICAL: 0, HIGH: 1, MODERATE: 0, LOW: 0, MARGINAL: 0 },
    cards: [{ id: "F1", criticality: "HIGH", title: "A discount above 100 percent makes the price negative", property: "Price is never negative.", cause: [{ path: "src/pricing.py", line: 3 }], reproSketch: "Call apply_discount(1000, 150).", control: "apply_discount(1000, 100) returns 0." }],
    oneLiners: [],
    report: { name: "report.json", size: Buffer.byteLength(reportText), sha256: crypto.createHash("sha256").update(reportText).digest("hex"), url: `/tasks/${id}/artifacts/report.json` },
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      let body = null;
      const url = new URL(req.url, base);
      try {
        const raw = (url.pathname === "/scan" && req.headers["content-encoding"] !== "identity" ? zlib.gunzipSync(rawBuf) : rawBuf).toString("utf8");
        body = raw ? JSON.parse(raw) : null;
      } catch { body = null; }
      st.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      const authed = req.headers.authorization === `Bearer ${st.key}` && !st.keyRevoked;

      if (req.method === "POST" && url.pathname === "/_control") {
        Object.assign(st, body || {});
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/_state") {
        return json(res, 200, { requests: st.requests.map((r) => ({ method: r.method, path: r.path })), scans: [...(st.scans || new Map()).keys()] });
      }
      // The signed link an artifact redirects to: no API key needed, and none must arrive.
      const fm = url.pathname.match(/^\/_files\/([^/]+)\/(.+)$/);
      if (req.method === "GET" && fm) {
        st.fileAuth = req.headers.authorization || null;
        if (fm[2] !== "report.json" || !st.scans?.has(fm[1])) return json(res, 404, { code: "NOT_FOUND", message: "x" });
        const t = reportText + (st.corruptArtifact ? "x" : "");
        res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(t) });
        return res.end(t);
      }
      // The console's device flow. Controls: connectApproved, connectStatus (denied|expired|consumed|failed),
      // connectStartStatus and pollStatus (an HTTP error), connectStartDelayMs, connectStartBody (fields to override).
      if (req.method === "POST" && url.pathname === "/api/cli-connect") {
        if (body && body.action === "start") {
          if (st.connectStartStatus) return json(res, st.connectStartStatus, { status: "busy" });
          st.connectCreated = (st.connectCreated || 0) + 1;
          st.connectKeyTaken = false;
          st.deviceCode = crypto.randomBytes(32).toString("hex");
          const out = { device_code: st.deviceCode, user_code: "KDRT-MWQX", expires_in: 600, interval: 3, ...st.connectStartBody };
          if (st.connectStartDelayMs) return void setTimeout(() => json(res, 201, out), st.connectStartDelayMs);
          return json(res, 201, out);
        }
        if (!body || body.action !== "poll" || !/^[a-f0-9]{64}$/.test(body.device_code || "")) return json(res, 400, { status: "invalid_request" });
        if (st.pollStatus) return json(res, st.pollStatus, { status: "invalid_request" });
        if (body.device_code !== st.deviceCode) return json(res, 200, { status: "expired" });
        if (st.connectStatus) return json(res, 200, { status: st.connectStatus });
        if (!st.connectApproved) return json(res, 200, { status: "pending" });
        if (st.connectKeyTaken) return json(res, 200, { status: "consumed" });
        st.connectKeyTaken = true;
        st.keyRevoked = false;
        return json(res, 200, { status: "approved", api_key: st.key });
      }
      // Scan. st.scan = { submit: [{status, code, reason, retryAfter}, ...] consumed one per POST,
      // statuses: [...] one per GET (last repeats; queued|running|done|failed|superseded), summary, error }.
      if (req.method === "POST" && url.pathname === "/scan") {
        if (!authed) return json(res, 401, ERR.unauthorized);
        const options = (st.scan = st.scan || {});
        if (belowMin(req.headers["x-intent-version"])) return upgrade(res);
        st.scanContentType = req.headers["content-type"];
        if (req.headers["content-type"] !== "application/gzip") return json(res, 400, { code: "INVALID_REQUEST", message: "The snapshot must be sent as application/gzip." });
        const fail = (options.submit || []).shift();
        if (fail && fail.drop) return void req.socket.destroy();
        if (fail) {
          const b = JSON.stringify({ code: fail.code || "x", message: fail.message || "x", ...(fail.reason ? { details: { reason: fail.reason } } : {}) });
          res.writeHead(fail.status, { "content-type": "application/json", ...(fail.retryAfter && fail.reason === "scan_ingest_busy" ? { "retry-after": String(fail.retryAfter) } : {}) });
          return res.end(b);
        }
        const idem = req.headers["idempotency-key"];
        options.idem = options.idem || new Map();
        let id = idem && options.idem.get(idem);
        const replay = !!id;
        if (!id) {
          id = newId();
          st.scans = st.scans || new Map();
          st.scans.set(id, { request: body, polls: 0 });
          if (idem) options.idem.set(idem, id);
        }
        return json(res, 202, { id, kind: "scan", status: replay ? (st.scans.get(id).done ? "completed" : st.scans.get(id).polls > 0 ? "running" : "queued") : "queued", semantics: null, createdAt: new Date().toISOString() });
      }
      if (req.method === "GET" && url.pathname === "/tasks") {
        if (!authed) return json(res, 401, ERR.unauthorized);
        if (st.tasksStatus) return json(res, st.tasksStatus, { code: "INTERNAL_ERROR", message: "x" });
        return json(res, 200, { tasks: [], hasMore: false });
      }
      // Artifacts answer 302 to a signed link on a host that wants no API key (here: this server's /_files).
      const am = url.pathname.match(/^\/tasks\/([^/]+)\/artifacts\/(report\.json)$/);
      if (req.method === "GET" && am) {
        if (!authed) return json(res, 401, ERR.unauthorized);
        const scan = st.scans && st.scans.get(am[1]);
        if (!scan) return json(res, 404, { code: "NOT_FOUND", message: "Task was not found." });
        if (!scan.done) return json(res, 409, { code: "ARTIFACT_NOT_AVAILABLE", message: "The task has not completed." });
        res.writeHead(302, { location: `${base}/_files/${am[1]}/${am[2]}` });
        return res.end();
      }
      const tm = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (req.method === "GET" && tm) {
        if (!authed) return json(res, 401, ERR.unauthorized);
        const id = tm[1];
        if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) return json(res, 400, { code: "INVALID_REQUEST", message: "The task ID is not a UUID." });
        const scan = st.scans && st.scans.get(id);
        if (scan) {
          const options = st.scan || {};
          if (options.getStatus) return json(res, options.getStatus, { code: "INTERNAL_ERROR", message: "x" });
          const seq = options.statuses || ["done"];
          const status = seq[Math.min(scan.polls++, seq.length - 1)];
          if (status === "queued" || status === "running") return json(res, 200, task(id, "scan", status));
          if (status === "superseded") return json(res, 200, task(id, "scan", "cancelled", { error: { code: "SUPERSEDED", message: "A newer scan replaced this one." } }));
          if (status === "failed") return json(res, 200, task(id, "scan", "failed", { error: options.error || { code: "SCAN_NO_REPORT", message: "Scan did not produce a usable report." } }));
          scan.done = true;
          const sum = options.summary || defaultSummary((scan.request && scan.request.depth) || "balanced", id);
          const budget = options.getBudget_s === undefined ? options.budget_s ?? sum.budgetSeconds : options.getBudget_s;
          const { budgetSeconds, ...rest } = sum;
          return json(res, 200, task(id, "scan", status === "data_expired" ? status : "completed", { result: { ...rest, ...(budget === null ? {} : { budgetSeconds: budget }) } }));
        }
        return json(res, 404, { code: "NOT_FOUND", message: "Task was not found." });
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
    scanUploads() {
      return st.requests.filter((r) => r.method === "POST" && r.path === "/scan").map((r) => r.body);
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fp = createFakeProver();
  fp.listen(Number(process.argv[2] || 0)).then((u) => console.log(u));
}
