// The prover client against the fake prover, in-process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers/env.js";
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
  assert.match(s.job_id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(s.url, `${config.consoleUrl()}/tasks/${s.job_id}`);
  const q = await api.getJob(TEST_KEY, s.job_id);
  assert.equal(q.job.status, "queued");
  const d = await api.getJob(TEST_KEY, s.job_id);
  assert.equal(d.job.status, "done");
  const c = d.job.result.agent_concerns[0];
  assert.deepEqual([c.path, c.type, c.claim_id], ["a.py", "intent_mismatch", "k1"]);
  assert.equal(d.job.result.verdict, "concerns");
  assert.equal(d.job.result.units[0].artifacts["SPEC.k"], "module SPEC\nendmodule\n");
  assert.equal(fp.state.fileAuth, null, "the signed link gets no API key");
  const req = fp.state.requests.find((r) => r.method === "POST" && r.path === "/intent-checks");
  assert.equal(req.headers["idempotency-key"], "idem-1");
  assert.equal(req.headers["x-intent-version"], config.pluginVersion());
});

test("errors come back as codes, never throws", async () => {
  assert.deepEqual(await api.submitJob("ic_bad", body, "k"), { ok: false, status: 401, code: "AUTHENTICATION_REQUIRED", reason: null });
  fp.state.submitStatus = { status: 429, code: "SPEND_CAP" };
  const r = await api.submitJob(TEST_KEY, body, "k");
  assert.equal(r.code, "SPEND_CAP");
  fp.state.submitStatus = null;
  const saved = process.env.INTENT_API_URL;
  process.env.INTENT_API_URL = "http://127.0.0.1:9";
  const down = await api.getJob(TEST_KEY, crypto.randomUUID(), 1000);
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

// Each way a task ends maps to the status the runner reads.
test("task statuses: completed, SUPERSEDED, failed, data_expired", async () => {
  const end = async (scenario) => {
    fp.state.scenario = scenario;
    const s = await api.submitJob(TEST_KEY, { ...body, units: [{ path: "b.py", sha256: "0".repeat(64) }] }, `k-${scenario}`);
    await api.getJob(TEST_KEY, s.job_id);
    return (await api.getJob(TEST_KEY, s.job_id)).job;
  };
  try {
    assert.equal((await end("no_concerns")).status, "done");
    assert.equal((await end("superseded")).status, "superseded");
    const failed = await end("failed");
    assert.deepEqual([failed.status, failed.error.code, failed.result], ["failed", "CHECK_FAILED", undefined]);
    const expired = await end("data_expired");
    assert.equal(expired.status, "done");
    assert.equal(expired.result.verdict, "concerns");
    assert.deepEqual(expired.result.units[0].artifacts, {}, "files are gone with the data");
  } finally {
    fp.state.scenario = "concerns";
  }
});

test("a DeepScan task maps to the summary the renderer reads", async () => {
  fp.state.deepscan = {};
  fp.state.scans = new Map();
  const s = await api.submitDeepscan(TEST_KEY, Buffer.from("x"), "scan-1");
  assert.equal(s.ok, true);
  const g = await api.getDeepscan(TEST_KEY, s.job_id);
  assert.equal(g.scan.status, "done");
  assert.equal(g.scan.budget_s, 3600, "balanced when the upload names no depth");
  assert.equal(g.scan.summary.cards[0].repro_sketch, "Call apply_discount(1000, 150).");
  assert.deepEqual(g.scan.summary.one_liners, []);
});

test("report links are accepted on the API origin and the console origin only", () => {
  assert.equal(api.isOwnLink(`${process.env.INTENT_API_URL}/x`), true);
  assert.equal(api.isOwnLink(`${config.consoleUrl()}/tasks/1`), true);
  assert.equal(api.isOwnLink("https://evil.example/tasks/1"), false);
});

// The fake prover answers with the same fields as the openapi examples, so a drift shows here.
test("the fake prover's task bodies carry the example tasks' fields", async () => {
  const ex = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "api", "examples", n), "utf8"));
  const keys = (o) => Object.keys(o).sort();
  const get = async (id) => (await fetch(`${process.env.INTENT_API_URL}/tasks/${id}`, { headers: { authorization: `Bearer ${TEST_KEY}` } })).json();
  fp.state.pollsBeforeDone = 0;
  fp.state.deepscan = {};
  fp.state.scans = new Map();
  try {
    const c = await get((await api.submitJob(TEST_KEY, body, "shape-1")).job_id);
    assert.deepEqual(keys(c), keys(ex("task-intent-check.json")));
    assert.deepEqual(keys(c.result), keys(ex("task-intent-check.json").result));
    assert.deepEqual(keys(c.result.units[0]), keys(ex("task-intent-check.json").result.units[0]));
    assert.deepEqual(keys(c.result.concerns[0]), keys(ex("task-intent-check.json").result.concerns[0]));
    const d = await get((await api.submitDeepscan(TEST_KEY, Buffer.from("x"), "shape-2")).job_id);
    assert.deepEqual(keys(d), keys(ex("task-deepscan.json")));
    assert.deepEqual(keys(d.result), keys(ex("task-deepscan.json").result));
    assert.deepEqual(keys(d.result.cards[0]), keys(ex("task-deepscan.json").result.cards[0]));
  } finally {
    fp.state.pollsBeforeDone = 1;
  }
});

test("an artifact whose hash does not match the task result is skipped, not written", async () => {
  fp.state.pollsBeforeDone = 0;
  fp.state.corruptArtifact = true;
  try {
    const s = await api.submitJob(TEST_KEY, body, "corrupt-1");
    const d = await api.getJob(TEST_KEY, s.job_id);
    assert.equal(d.job.status, "done");
    assert.deepEqual(d.job.result.units[0].artifacts, {});
  } finally { fp.state.corruptArtifact = false; fp.state.pollsBeforeDone = 1; }
});

test("426 below the minimum plugin version, and a 400 task id counts as dead", async () => {
  fp.state.minVersion = "99.0.0";
  try {
    const r = await api.submitJob(TEST_KEY, body, "old-1");
    assert.deepEqual([r.ok, r.status, r.code], [false, 426, "UPGRADE_REQUIRED"]);
  } finally { fp.state.minVersion = "0.1.0"; }
  const dead = await api.getJob(TEST_KEY, "A".repeat(22));
  assert.deepEqual([dead.ok, dead.status], [false, 404]);
});
