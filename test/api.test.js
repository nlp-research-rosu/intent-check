// The Intent Prover API client against the fake service, in-process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT } from "./helpers/env.js";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { tmpdir } from "./helpers/env.js";

let fp;
let api;
let config;
before(async () => {
  fp = createFakeProver();
  process.env.INTENT_API_URL = process.env.INTENT_CONSOLE_URL = await fp.listen();
  process.env.CLAUDE_PLUGIN_DATA = tmpdir("intent-api-");
  api = await import("../lib/api.js");
  config = await import("../lib/config.js");
});
after(() => fp.close());

const body = zlib.gzipSync(fs.readFileSync(path.join(ROOT, "test", "fixtures", "api", "examples", "scan-upload.json")));

test("submit and poll a Scan", async () => {
  fp.state.scan = { statuses: ["queued", "done"] };
  const s = await api.submitScan(TEST_KEY, body, "idem-1");
  assert.equal(s.ok, true);
  assert.match(s.job_id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(s.url, `${config.consoleUrl()}/tasks/${s.job_id}`);
  const q = await api.getScan(TEST_KEY, s.job_id);
  assert.equal(q.scan.status, "queued");
  const d = await api.getScan(TEST_KEY, s.job_id);
  assert.equal(d.scan.status, "done");
  const report = await api.getScanReport(TEST_KEY, d.task);
  assert.equal(report.ok, true);
  assert.equal(fp.state.fileAuth, null, "the signed link gets no API key");
  const req = fp.state.requests.find((r) => r.method === "POST" && r.path === "/scan");
  assert.equal(req.headers["idempotency-key"], "idem-1");
  assert.equal(req.headers["x-intent-version"], config.pluginVersion());
});

test("errors come back as codes, never throws", async () => {
  assert.equal((await api.submitScan("ic_bad", body, "k")).status, 401);
  fp.state.scan = { submit: [{ status: 429, code: "SPEND_CAP" }] };
  const r = await api.submitScan(TEST_KEY, body, "k");
  assert.equal(r.code, "SPEND_CAP");
  const saved = process.env.INTENT_API_URL;
  process.env.INTENT_API_URL = "http://127.0.0.1:9";
  const down = await api.getScan(TEST_KEY, crypto.randomUUID(), 1000);
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
  process.env.INTENT_API_URL = saved;
});

test("checkKey: the key is checked with GET /tasks?limit=1", async () => {
  assert.deepEqual(await api.checkKey(TEST_KEY), { ok: true });
  const r = await api.checkKey("wrong");
  assert.deepEqual([r.ok, r.status], [false, 401]);
  assert.ok(fp.state.requests.some((q) => q.method === "GET" && q.path === "/tasks"));
});

// Each way a task ends maps to the status the runner reads.
test("task statuses: completed, SUPERSEDED, failed, data_expired", async () => {
  const end = async (scenario) => {
    fp.state.scan = { statuses: [scenario] };
    const s = await api.submitScan(TEST_KEY, body, `k-${scenario}`);
    return (await api.getScan(TEST_KEY, s.job_id)).scan;
  };
  try {
    assert.equal((await end("done")).status, "done");
    assert.equal((await end("superseded")).status, "superseded");
    const failed = await end("failed");
    assert.deepEqual([failed.status, failed.error.code, failed.summary], ["failed", "SCAN_NO_REPORT", undefined]);
    const expired = await end("data_expired");
    assert.equal(expired.status, "done");
    assert.equal(expired.summary.counts.HIGH, 1);
  } finally {
    fp.state.scan = {};
  }
});

test("a Scan task maps to the summary the renderer reads", async () => {
  fp.state.scan = {};
  fp.state.scans = new Map();
  const s = await api.submitScan(TEST_KEY, body, "scan-1");
  assert.equal(s.ok, true);
  const g = await api.getScan(TEST_KEY, s.job_id);
  assert.equal(g.scan.status, "done");
  assert.equal(g.scan.budget_s, 3600, "balanced depth");
  assert.equal(g.scan.summary.cards[0].repro_sketch, "Call apply_discount(1000, 150).");
  assert.deepEqual(g.scan.summary.one_liners, []);
});

// The fake prover answers with the same fields as the openapi examples, so a drift shows here.
test("the fake prover's task bodies carry the example tasks' fields", async () => {
  const ex = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "api", "examples", n), "utf8"));
  const keys = (o) => Object.keys(o).sort();
  const get = async (id) => (await fetch(`${process.env.INTENT_API_URL}/tasks/${id}`, { headers: { authorization: `Bearer ${TEST_KEY}` } })).json();
  fp.state.scan = {};
  fp.state.scans = new Map();
  try {
    const d = await get((await api.submitScan(TEST_KEY, body, "shape-2")).job_id);
    assert.deepEqual(keys(d), keys(ex("task-scan.json")));
    assert.deepEqual(keys(d.result), keys(ex("task-scan.json").result));
    assert.deepEqual(keys(d.result.cards[0]), keys(ex("task-scan.json").result.cards[0]));
  } finally {
    fp.state.scan = {};
  }
});

test("a report with a bad hash is rejected and can be downloaded again", async () => {
  fp.state.corruptArtifact = true;
  try {
    const s = await api.submitScan(TEST_KEY, body, "corrupt-1");
    const task = (await api.getScan(TEST_KEY, s.job_id)).task;
    const d = await api.getScanReport(TEST_KEY, task);
    assert.deepEqual([d.ok, d.status, d.code], [false, 0, "REPORT_HASH_MISMATCH"]);
    fp.state.corruptArtifact = false;
    assert.equal((await api.getScanReport(TEST_KEY, task)).ok, true);
  } finally { fp.state.corruptArtifact = false; }
});

test("426 below the minimum plugin version and invalid task IDs are reported", async () => {
  fp.state.minVersion = "99.0.0";
  try {
    const r = await api.submitScan(TEST_KEY, body, "old-1");
    assert.deepEqual([r.ok, r.status, r.code], [false, 426, "UPGRADE_REQUIRED"]);
  } finally { fp.state.minVersion = "0.1.0"; }
  const dead = await api.getScan(TEST_KEY, "A".repeat(22));
  assert.deepEqual([dead.ok, dead.status], [false, 400]);
});
