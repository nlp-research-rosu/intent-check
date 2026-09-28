// The prover client against the fake prover, in-process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { tmpdir } from "./helpers/env.js";

let fp;
let api;
let config;
before(async () => {
  fp = createFakeProver({ pollsBeforeDone: 1 });
  process.env.INTENT_API_URL = await fp.listen();
  process.env.CLAUDE_PLUGIN_DATA = tmpdir("intent-api-");
  api = await import("../lib/api.js");
  config = await import("../lib/config.js");
});
after(() => fp.close());

const body = { contract_version: "1", units: [{ path: "a.py", sha256: "0".repeat(64) }] };

test("submit and poll a job", async () => {
  const s = await api.submitJob(TEST_KEY, body, "idem-1");
  assert.equal(s.ok, true);
  assert.match(s.job_id, /^[A-Za-z0-9]{22}$/);
  const q = await api.getJob(TEST_KEY, s.job_id);
  assert.equal(q.job.status, "queued");
  const d = await api.getJob(TEST_KEY, s.job_id);
  assert.equal(d.job.status, "done");
  assert.equal(d.job.result.agent_concerns[0].path, "a.py");
  const req = fp.state.requests.find((r) => r.method === "POST" && r.path === "/v1/jobs");
  assert.equal(req.headers["idempotency-key"], "idem-1");
  assert.equal(req.headers["x-intent-version"], config.pluginVersion());
});

test("errors come back as codes, never throws", async () => {
  assert.deepEqual(await api.submitJob("ic_bad", body, "k"), { ok: false, status: 401, code: "unauthorized", reason: null });
  fp.state.submitStatus = { status: 429, code: "spend_cap" };
  const r = await api.submitJob(TEST_KEY, body, "k");
  assert.equal(r.code, "spend_cap");
  fp.state.submitStatus = null;
  const saved = process.env.INTENT_API_URL;
  process.env.INTENT_API_URL = "http://127.0.0.1:9";
  const down = await api.getJob(TEST_KEY, "x".repeat(22), 1000);
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
  process.env.INTENT_API_URL = saved;
});

test("connect start and poll", async () => {
  const c = await api.startConnect({ host: "claude-code", host_version: "x", plugin_version: "0.1.0", os: "linux" });
  assert.equal(c.ok, true);
  assert.match(c.verification_url, /\/connect\/KDRT-MWQX$/);
  assert.equal((await api.pollConnect(c.device_code)).status, "pending");
  fp.state.connectApproved = true;
  const a = await api.pollConnect(c.device_code);
  assert.deepEqual([a.status, a.api_key], ["approved", TEST_KEY]);
  assert.equal((await api.pollConnect(c.device_code)).status, "consumed");
});

test("only http(s) report links are accepted", () => {
  assert.equal(api.isHttpUrl("https://x.test/r/1"), true);
  for (const u of ["javascript:alert(1)", "file:///etc/passwd", "https://x.test/r/1 extra", "", null]) assert.equal(api.isHttpUrl(u), false, String(u));
});
