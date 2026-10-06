// Per-edit preview: every Edit/Write is checked as it happens, findings reach the agent mid-turn,
// Stop stays the safety net.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { fixture, tmpdir, makeRepo, baseEnv, runHook, readSessionFiles, saveKey, waitFor, sleep, ROOT } from "./helpers/env.js";

const V1 = "def apply_discount(price_cents, percent):\n    return price_cents - price_cents * percent // 100\n\ndef total(items):\n    return sum(items)\n";
const V2 = V1 + "\ndef tax(x):\n    return x * 2\n\ndef net(x):\n    return x - tax(x)\n";
const V3 = V2 + "\ndef gross(x):\n    return x + tax(x)\n\ndef half(x):\n    return x // 2\n";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));

function setup({ perEdit = "1" } = {}) {
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY);
  const repo = makeRepo();
  fs.writeFileSync(path.join(data, "global.json"), JSON.stringify({ consent_shown_at: "2026-09-28T00:00:00Z" }));
  return { data, repo: repo.dir, env: baseEnv(data, fp.url, { INTENT_PER_EDIT: perEdit }) };
}

async function prompt(ctx) {
  await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "Add discount helpers. The result must never go below zero." }), ctx.env);
}

// The agent writes `rel` and Claude Code fires PostToolUse.
async function edit(ctx, rel, content, id) {
  const abs = path.join(ctx.repo, rel);
  fs.writeFileSync(abs, content);
  return runHook("post-tool", fixture("post-tool-write", ctx.repo, { tool_input: { file_path: abs, content }, tool_use_id: id }), ctx.env);
}

const submitted = (n) => waitFor(() => fp.jobRequests().length >= n);
const post = () => fp.state.requests.filter((r) => r.method === "POST" && r.path === "/v1/jobs");
const editJobs = (ctx) => Object.values(readSessionFiles(ctx.data)[0].edit_jobs);

test("post-tool spawns a per-edit check and stays fast", async () => {
  const ctx = setup();
  await prompt(ctx);
  const n = fp.jobRequests().length;
  const r = await edit(ctx, "pricing.py", V1, "toolu_a");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.ok(await submitted(n + 1), "a job was submitted by the detached child");
  const [req] = fp.jobRequests().slice(n);
  assert.equal(req.units[0].path, "pricing.py");
  const times = [r.ms];
  for (const id of ["toolu_b", "toolu_c"]) times.push((await edit(ctx, "other.py", V2 + id, id)).ms);
  assert.ok(Math.min(...times) < 400, JSON.stringify(times));
});

test("three sequential edits to one file make three jobs, none superseded, all with the header", async () => {
  fp.state.pollsBeforeDone = 3;
  const ctx = setup();
  await prompt(ctx);
  const n = fp.jobRequests().length;
  for (const [i, c] of [V1, V2, V3].entries()) {
    await edit(ctx, "pricing.py", c, `toolu_${i}`);
    assert.ok(await submitted(n + i + 1), `job ${i + 1}`);
  }
  const posts = post().slice(n);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((p) => p.headers["idempotency-key"])).size, 3);
  for (const p of posts) assert.equal(p.headers["x-intent-supersede"], "off");
  assert.equal([...fp.state.jobs.values()].filter((j) => j.superseded).length, 0);
});

test("a concern from an earlier edit's check reaches the agent on its next edit", async () => {
  const ctx = setup();
  await prompt(ctx);
  await edit(ctx, "pricing.py", V1, "toolu_1");
  assert.ok(await waitFor(() => (readSessionFiles(ctx.data)[0]?.notes || []).some((x) => x.kind === "concerns")), "concern note");
  const r = await edit(ctx, "pricing.py", V2, "toolu_2");
  assert.equal(r.json.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(r.json.hookSpecificOutput.additionalContext, /Intent mismatch \(high\) at pricing\.py:3/);
  // Delivered once.
  const r2 = await edit(ctx, "pricing.py", V3, "toolu_3");
  assert.doesNotMatch(r2.stdout, /Intent mismatch/);
});

test("Stop does not resubmit a file a per-edit check already covers", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await prompt(ctx);
  await edit(ctx, "pricing.py", V1, "toolu_1");
  assert.ok(await waitFor(() => editJobs(ctx).some((e) => e.settled)), "settled");
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fp.jobRequests().length, n);
});

test("Stop still checks a file that changed after its per-edit check", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await prompt(ctx);
  await edit(ctx, "pricing.py", V1, "toolu_1");
  assert.ok(await waitFor(() => editJobs(ctx).some((e) => e.settled)), "settled");
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), V3); // e.g. a Bash edit
  const n = fp.jobRequests().length;
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(fp.jobRequests().length, n + 1);
});

test("Stop wakes the agent on a concern from a per-edit job still in flight", async () => {
  fp.state.pollsBeforeDone = 1; // queued on the child's first poll; done on the next
  const ctx = setup();
  await prompt(ctx);
  await edit(ctx, "pricing.py", V1, "toolu_1");
  assert.ok(await waitFor(() => editJobs(ctx).length === 1), "job recorded");
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /Intent mismatch \(high\) at pricing\.py:3/);
  assert.equal(fp.jobRequests().length, n);
  const s = readSessionFiles(ctx.data)[0];
  assert.deepEqual(s.pending, []);
  assert.equal(s.notes.filter((x) => x.kind === "concerns").length, 0);
});

test("per-edit off: no check at the edit, the normal Stop check", async () => {
  const ctx = setup({ perEdit: "0" });
  await prompt(ctx);
  const n = fp.jobRequests().length;
  await edit(ctx, "pricing.py", V1, "toolu_1");
  await sleep(800);
  assert.equal(fp.jobRequests().length, n);
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(fp.jobRequests().length, n + 1);
});

test("per-edit command and status", async () => {
  const ctx = setup({ perEdit: "" });
  delete ctx.env.INTENT_PER_EDIT;
  const run = (...a) => import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath, [path.join(ROOT, "bin", "intent.js"), ...a], { env: ctx.env, encoding: "utf8" }));
  assert.match((await run("status")).stdout, /Per-edit checks: on/);
  assert.match((await run("per-edit", "off")).stdout, /Per-edit checks are off/);
  assert.match((await run("status")).stdout, /Per-edit checks: off/);
  assert.match((await run("per-edit", "on")).stdout, /Per-edit checks are on/);
});

const sessionFile = (ctx) => { const d = path.join(ctx.data, "sessions"); return path.join(d, fs.readdirSync(d).find((f) => f.endsWith(".json"))); };
function seedEdits(ctx, n, extra) {
  const f = sessionFile(ctx);
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  for (let i = 0; i < n; i++) s.edit_jobs[`J${i}`] = { job_id: `J${i}`, rel: `x${i}.py`, sha256: "0".repeat(64), submitted_at: Date.now(), ...extra };
  fs.writeFileSync(f, JSON.stringify(s));
}

test("past 12 in-flight checks no more are spawned, and Stop still covers the content", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await prompt(ctx);
  seedEdits(ctx, 12);
  const n = fp.jobRequests().length;
  await edit(ctx, "pricing.py", V1, "toolu_1");
  await sleep(800);
  assert.equal(fp.jobRequests().length, n);
  await runHook("stop", fixture("stop", ctx.repo), { ...ctx.env, INTENT_API_URL: fp.url }); // pending fake entries 404 and are dropped
  assert.equal(fp.jobRequests().length, n + 1);
});

test("an expired unsettled per-edit entry neither covers a file nor survives Stop", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await prompt(ctx);
  await edit(ctx, "pricing.py", V1, "toolu_1");
  assert.ok(await waitFor(() => editJobs(ctx).some((e) => e.settled)));
  const f = sessionFile(ctx);
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const e of Object.values(s.edit_jobs)) { e.settled = false; e.submitted_at = Date.now() - 25 * 3600 * 1000; }
  fs.writeFileSync(f, JSON.stringify(s));
  const n = fp.jobRequests().length;
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(fp.jobRequests().length, n + 1);
  assert.equal(editJobs(ctx).filter((e) => e.job_id === Object.keys(s.edit_jobs)[0]).length, 0);
});

test("writeUnit: an older job finishing late does not overwrite a unit from newer content", async () => {
  const { writeUnit } = await import("../lib/intentdir.js");
  const root = tmpdir("intent-unit-");
  const unit = (v) => ({ path: "a.py", checked_sha256: "a".repeat(64), verdict: "no_concerns", artifacts: { "INTENT.md": v } });
  const res = { checked_at: "2026-01-01T00:00:00Z" };
  assert.equal(writeUnit(root, unit("new"), { job_id: "N", url: "http://x/n", submitted_at: 2000 }, res), true);
  assert.equal(writeUnit(root, unit("old"), { job_id: "O", url: "http://x/o", submitted_at: 1000 }, res), false);
  assert.equal(fs.readFileSync(path.join(root, ".intent", "a.py", "INTENT.md"), "utf8"), "new");
  assert.equal(writeUnit(root, unit("legacy"), { job_id: "L", url: "http://x/l" }, res), true);
});

// ---- auth interplay: the key that was sent decides what a 401 does ------------------------------

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const notesText = (ctx) => readSessionFiles(ctx.data).flatMap((s) => (s.notes || []).map((n) => n.text || n.user || "")).join("\n");
const sessionJson = (ctx) => path.join(ctx.data, "sessions", fs.readdirSync(path.join(ctx.data, "sessions")).find((x) => x.endsWith(".json")));

function savedKeyCtx() {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  fp.state.keyRevoked = false;
  return ctx;
}

async function inProcess(ctx, fn) {
  const keys = ["CLAUDE_PLUGIN_DATA", "INTENT_API_URL", "INTENT_API_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  delete process.env.INTENT_API_KEY;
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: ctx.data, INTENT_API_URL: fp.url });
  try { return await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test("a per-edit 401 with a saved key clears it, marks connect.json revoked, and the next prompt says why", async () => {
  const ctx = savedKeyCtx();
  await prompt(ctx);
  fp.state.keyRevoked = true;
  try {
    await edit(ctx, "pricing.py", V1, "toolu_1");
    const cfg = path.join(ctx.data, "config.json");
    assert.ok(await waitFor(() => !((readJson(cfg).keys || {})[fp.url])), "saved key cleared");
    const c = path.join(ctx.data, "connect.json");
    assert.ok(await waitFor(() => fs.existsSync(c) && readJson(c).status === "pending", { timeoutMs: 10000 }), "connect.json updated with a new request");
    assert.match(readJson(c).reason || "", /no longer accepted/);
    const r = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "carry on with the next task please" }), ctx.env);
    assert.match(r.json.systemMessage, /no longer accepted/);
  } finally { fp.state.keyRevoked = false; }
});

test("two concurrent per-edit 401s do not claim INTENT_API_KEY was rejected", async () => {
  const ctx = savedKeyCtx();
  await prompt(ctx);
  fp.state.keyRevoked = true;
  fp.state.submitDelayMs = 400;
  try {
    await Promise.all([edit(ctx, "pricing.py", V1, "toolu_1"), edit(ctx, "other.py", V2, "toolu_2")]);
    assert.ok(await waitFor(() => !((readJson(path.join(ctx.data, "config.json")).keys || {})[fp.url])));
    await sleep(1500);
    assert.doesNotMatch(notesText(ctx), /INTENT_API_KEY/);
  } finally { fp.state.keyRevoked = false; fp.state.submitDelayMs = 0; }
});

test("a key re-saved between the request and its 401 survives", async () => {
  const ctx = savedKeyCtx();
  const { handleSubmitFailure } = await import("../lib/runner.js");
  const { saveApiKey, apiKey } = await import("../lib/config.js");
  const NEW = "ic_" + "N".repeat(38);
  await inProcess(ctx, async () => {
    saveApiKey(NEW);
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, TEST_KEY);
    assert.equal(apiKey().key, NEW);
  });
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
});

test("an env-key 401 from a per-edit check adds the env note, pauses, and keeps the key", async () => {
  const ctx = setup();
  ctx.env.INTENT_API_KEY = "ic_" + "R".repeat(38);
  await prompt(ctx);
  await edit(ctx, "pricing.py", V1, "toolu_1");
  assert.ok(await waitFor(() => /INTENT_API_KEY was not accepted/.test(notesText(ctx))), "env note");
  const g = readJson(path.join(ctx.data, "global.json"));
  assert.equal(g.paused.code, 401);
  assert.equal(g.paused.source, "env");
  assert.equal(readJson(path.join(ctx.data, "config.json")).api_key, TEST_KEY);
});

test("a successful per-edit submit records the last check", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await prompt(ctx);
  const out0 = await runHook("status", undefined, ctx.env);
  assert.match(out0.stdout, /Last check: none yet/);
  await edit(ctx, "pricing.py", V1, "toolu_1");
  assert.ok(await waitFor(() => { try { return readJson(path.join(ctx.data, "global.json")).last_check?.ok === true; } catch { return false; } }));
  const out = await runHook("status", undefined, ctx.env);
  assert.doesNotMatch(out.stdout, /Last check: none yet/);
});

// ---- spawn gating ---------------------------------------------------------------------------------

test("no per-edit job is spawned for a paused key", async () => {
  const ctx = savedKeyCtx();
  await prompt(ctx);
  const { pause } = await import("../lib/pause.js");
  await inProcess(ctx, async () => pause(TEST_KEY, 401));
  const n = fp.jobRequests().length;
  await edit(ctx, "pricing.py", V1, "toolu_1");
  await sleep(800);
  assert.equal(fp.jobRequests().length, n);
});

test("no per-edit job is spawned for an unverified legacy key", async () => {
  const ctx = setup(); // legacy api_key that no prompt or SessionStart has promoted yet
  const n = fp.jobRequests().length;
  await edit(ctx, "pricing.py", V1, "toolu_1");
  await sleep(800);
  assert.equal(fp.jobRequests().length, n);
});

test("spawned-but-unregistered checks count toward the in-flight cap, and reservations expire", async () => {
  const ctx = savedKeyCtx();
  await prompt(ctx);
  await edit(ctx, "pricing.py", V1, "toolu_0"); // creates the session file
  assert.ok(await waitFor(() => editJobs(ctx).some((e) => e.settled)), "first check settled");
  const { MAX_INFLIGHT_EDITS, EDIT_RESERVE_MS } = await import("../lib/runner.js");
  const file = sessionJson(ctx);
  const s = readJson(file);
  s.edit_jobs = {};
  s.edit_reserved = {};
  for (let i = 0; i < MAX_INFLIGHT_EDITS; i++) s.edit_reserved[`r${i}`] = Date.now();
  fs.writeFileSync(file, JSON.stringify(s));
  const n = fp.jobRequests().length;
  await edit(ctx, "pricing.py", V2, "toolu_1");
  await sleep(1500);
  assert.equal(fp.jobRequests().length, n, "capped by reservations alone");
  const s2 = readJson(file);
  for (const id of Object.keys(s2.edit_reserved)) s2.edit_reserved[id] = Date.now() - EDIT_RESERVE_MS - 1000;
  fs.writeFileSync(file, JSON.stringify(s2));
  await edit(ctx, "pricing.py", V3, "toolu_2");
  assert.ok(await waitFor(() => fp.jobRequests().length > n, { timeoutMs: 8000 }), "expired reservations free the slots");
});
