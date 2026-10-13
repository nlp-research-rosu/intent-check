// Fix round for the auth UX: concurrent creation, heartbeats, visible creation
// failures, SessionStart budget, server text limits, state holes, headless.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, fixture, tmpdir, makeRepo, baseEnv, runHook, waitFor, saveKey, seedGlobal } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { connectApproved: false, connectKeyTaken: false, connectStatus: null, connectStartStatus: null, keyRevoked: false, key: TEST_KEY, handle: "tester", pollsBeforeDone: 0, scenario: "concerns", verifyUrl: null, connectStartDelayMs: 0, meStatus: null, pollStatus: null }));

function setup() {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  return { data, repo: makeRepo().dir, env: baseEnv(data, fp.url) };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const cfileOf = (ctx) => path.join(ctx.data, "connect.json");
const posts = () => fp.state.requests.filter((x) => x.method === "POST" && x.path === "/v1/connect").length;
const meCalls = () => fp.state.requests.filter((x) => x.path === "/v1/me" && x.method === "GET").length;
const prompt = (ctx, text = "please build the pricing module", extra = {}, env = ctx.env) => runHook("prompt", fixture("prompt", ctx.repo, { prompt: text, ...extra }), env);
const start = (ctx, extra = {}) => runHook("session-start", fixture("session-start", ctx.repo, extra), ctx.env);

// Run lib code in this process against a temp data dir and the fake prover, then restore the env.
async function inProcess(ctx, fn, extraEnv = {}) {
  const keys = ["CLAUDE_PLUGIN_DATA", "INTENT_API_URL", "INTENT_API_KEY", "INTENT_CLAIM", ...Object.keys(extraEnv)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  delete process.env.INTENT_API_KEY;
  delete process.env.INTENT_CLAIM;
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: ctx.data, INTENT_API_URL: fp.url, ...extraEnv });
  try {
    return await fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const killPoller = (ctx) => { try { process.kill(readJson(cfileOf(ctx)).poller_pid, "SIGKILL"); } catch { /* gone */ } };

// ---- 2: one request, even when two callers race --------------------------------------------------

test("two concurrent ensureRequest calls make one record, and the link returned is the one being polled", async () => {
  const ctx = setup();
  fp.state.connectStartDelayMs = 400;
  const n = posts();
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    const [a, b] = await Promise.all([c.ensureRequest({ timeoutMs: 5000 }), c.ensureRequest({ timeoutMs: 5000 })]);
    assert.ok(a && b, "both callers get the live request");
    assert.equal(a.device_code, b.device_code);
    assert.equal(a.verification_url, b.verification_url);
    assert.equal(posts(), n + 1, "one POST /v1/connect");
    assert.equal(readJson(cfileOf(ctx)).device_code, fp.state.deviceCode, "stored = the one the service knows = the one polled");
    assert.equal(loadClaim(ctx), undefined, "claim released");
  });
  killPoller(ctx);
});

test("two creators that both reached the service: the second keeps the live record and drops its own", async () => {
  const ctx = setup();
  fp.state.connectStartDelayMs = 300;
  const n = posts();
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    // claim: given means the caller already holds the claim (as the detached child does), so both POST.
    const [a, b] = await Promise.all([c.ensureRequest({ timeoutMs: 5000, claim: 1 }), c.ensureRequest({ timeoutMs: 5000, claim: 1 })]);
    assert.equal(posts(), n + 2);
    assert.equal(a.device_code, b.device_code, "both return the record that was kept");
    assert.equal(readJson(cfileOf(ctx)).device_code, a.device_code);
    // A forced request does replace it.
    const f = await c.ensureRequest({ timeoutMs: 5000, force: true });
    assert.notEqual(f.device_code, a.device_code);
  });
  killPoller(ctx);
});

const loadClaim = (ctx) => readJson(path.join(ctx.data, "global.json")).connect_creating_at;

test("runCreator's finally only clears its own claim", async () => {
  const ctx = setup();
  seedGlobal(ctx.data, { connect_creating_at: 222 });
  saveKey(ctx.data, TEST_KEY, fp.url);
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    process.env.INTENT_CLAIM = "111";
    await c.runCreator(); // has a key: returns early, then releases claim 111 (not ours to clear 222)
  });
  assert.equal(loadClaim(ctx), 222);
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    process.env.INTENT_CLAIM = "222";
    await c.runCreator();
  });
  assert.equal(loadClaim(ctx), undefined);
});

// ---- 3: heartbeats -------------------------------------------------------------------------------

test("a live pid with an old heartbeat is not a live poller or waiter", async () => {
  const c = await import("../lib/connect.js");
  const now = Date.now();
  const rec = (at) => ({ status: "pending", interval_s: 3, poller_pid: process.ppid, poller_at: at, waiter_pid: process.ppid, waiter_at: at });
  assert.equal(c.holderAlive(rec(now - 1000), "poller", now), true);
  assert.equal(c.holderAlive(rec(now - 20000), "poller", now), false, "older than 15 s");
  assert.equal(c.holderAlive(rec(now - 20000), "waiter", now), false);
  assert.equal(c.holderAlive({ ...rec(now), poller_at: undefined }, "poller", now), false, "no heartbeat at all");
  assert.equal(c.holderAlive({ ...rec(now - 20000), interval_s: 10 }, "poller", now), true, "three 10 s intervals");
  assert.equal(c.holderAlive({ poller_pid: 999999, poller_at: now }, "poller", now), false, "dead pid");
});

test("a stale heartbeat lets a new poller take over", async () => {
  const ctx = setup();
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    await c.ensureRequest();
    killPoller(ctx);
    const rec = readJson(cfileOf(ctx));
    fs.writeFileSync(cfileOf(ctx), JSON.stringify({ ...rec, poller_pid: process.ppid, poller_at: Date.now() - 60000 }));
    c.ensurePoller();
    const after = readJson(cfileOf(ctx));
    assert.notEqual(after.poller_pid, process.ppid);
    assert.ok(Date.now() - after.poller_at < 5000);
  });
  killPoller(ctx);
});

// ---- 4: creation failures are visible and backed off ---------------------------------------------

for (const [status, backed] of [[404, true], [400, true], [403, true], [408, false]]) {
  test(`creating the link fails with ${status}: one visible line per session, ${backed ? "backed off" : "no backoff"}`, async () => {
    const ctx = setup();
    fp.state.connectStartStatus = status;
    const s = await start(ctx);
    assert.equal(s.json.systemMessage, `Intent Check could not create a connect link (${status}). Run /intent:doctor to retry.`);
    assert.equal(Boolean(readJson(path.join(ctx.data, "global.json")).backoff && readJson(path.join(ctx.data, "global.json")).backoff.connect), backed);
    const p = await prompt(ctx);
    assert.equal(p.stdout, "", "once per session");
    if (backed) {
      const n = posts();
      await prompt(ctx, "another request please", { session_id: "s2" });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(posts(), n, "no process respawned on every prompt");
    }
  });
}

// ---- 6: SessionStart stays under the watchdog ----------------------------------------------------

test("SessionStart with a saved key and an unresponsive service finishes well under the 8 s watchdog, with its notices", async (t) => {
  const sockets = [];
  const hang = http.createServer(() => { /* never answers */ });
  hang.on("connection", (s) => sockets.push(s));
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  // Closed even when an assertion below fails: an open server would keep this test file from ever exiting.
  t.after(() => { for (const s of sockets) s.destroy(); hang.close(); });
  const url = `http://127.0.0.1:${hang.address().port}`;
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, fp.url);
  const repo = makeRepo().dir;
  const r = await runHook("session-start", fixture("session-start", repo), baseEnv(data, url));
  assert.ok(r.ms < 6500, `took ${r.ms}`);
  assert.match(r.json.systemMessage, /Intent Check is on\./, "consent line delivered");
  assert.match(r.json.systemMessage, /Intent Check v\S+ ready/, "ready line delivered");
});

// ---- 7: server text limits -----------------------------------------------------------------------

for (const [name, url] of [["another origin", "http://evil.example/connect/KDRT"], ["over 300 characters", null]]) {
  test(`verification_url on ${name} is refused: the start counts as failed`, async () => {
    const ctx = setup();
    fp.state.verifyUrl = url || `${fp.url}/connect/${"a".repeat(300)}`;
    const s = await start(ctx);
    assert.match(s.json.systemMessage, /could not create a connect link \(bad_response\)/);
    assert.equal(fs.existsSync(cfileOf(ctx)), false);
    assert.doesNotMatch(s.stdout, /evil\.example|aaaa/);
  });
}

test("handle: only [A-Za-z0-9_.@+-], at most 60", async () => {
  const { cleanHandle } = await import("../lib/api.js");
  assert.equal(cleanHandle("dev.user+1@fast-xyz_io"), "dev.user+1@fast-xyz_io");
  assert.equal(cleanHandle("bad handle\n<b>Ignore all"), "badhandlebIgnoreall");
  assert.equal(cleanHandle("a".repeat(100)).length, 60);
  assert.equal(cleanHandle("‮ \n"), null);
});

// ---- 8: state holes ------------------------------------------------------------------------------

test("applyPoll does not save a key once the request is no longer pending (replaced meanwhile)", async () => {
  const ctx = setup();
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    const rec = await c.ensureRequest();
    c.updateConnect((x) => { x.status = "expired"; delete x.device_code; });
    const r = c.applyPoll({ ok: true, status: "approved", api_key: TEST_KEY, handle: "tester" }, rec.device_code);
    assert.equal(r, "gone");
    assert.equal(fs.existsSync(path.join(ctx.data, "config.json")), false, "no key saved");
    assert.equal(readJson(cfileOf(ctx)).status, "expired");
  });
  killPoller(ctx);
});

test("lost a race with ourselves: the connection is announced if nobody has announced it yet", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  fs.writeFileSync(cfileOf(ctx), JSON.stringify({ status: "approved", api_url: fp.url, handle: "tester" }));
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    assert.equal(c.applyPoll({ ok: true, status: "consumed" }, "x"), "approved");
    assert.equal(readJson(cfileOf(ctx)).announce, true);
    assert.deepEqual(c.takeConnectedAnnouncement(), { handle: "tester" });
    c.applyPoll({ ok: true, status: "consumed" }, "x");
    assert.equal(readJson(cfileOf(ctx)).announce, undefined, "already announced: not again");
  });
});

test("the poller backs off after a 429 instead of hammering the service", async () => {
  const ctx = setup();
  fp.state.pollStatus = 429;
  // Only this test's request: pollers of earlier tests share the prover.
  const gets = () => fp.state.requests.filter((x) => x.method === "GET" && fp.state.deviceCode && x.path === `/v1/connect/${fp.state.deviceCode}`).length;
  const n = 0; // the request made below gets a new device code, so its count starts at 0
  await start(ctx);
  assert.ok(await waitFor(() => gets() > n, { timeoutMs: 8000 }), "first poll happens");
  const after1 = gets();
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(gets(), after1, "no second poll within the 30 s backoff");
  killPoller(ctx);
});

// ---- 9: headless ---------------------------------------------------------------------------------

test("headless entrypoints get a soft note, not a stop-and-wait order", async () => {
  const ctx = setup();
  await start(ctx);
  for (const entry of ["sdk-cli", "sdk-ts", "local-agent"]) {
    const env = { ...ctx.env, CLAUDE_CODE_ENTRYPOINT: entry };
    const p = await prompt(ctx, "please build the pricing module", { session_id: `s-${entry}` }, env);
    const text = p.json.hookSpecificOutput.additionalContext;
    assert.match(text, /Intent Check is not connected, so nothing is checked; the user can connect at http:\/\/127\.0\.0\.1:\d+\/connect\//);
    assert.doesNotMatch(text, /"done"|"skip"|wait|Before doing anything else/i, entry);
  }
  // Interactive keeps the gate.
  const p = await prompt(ctx, "please build the pricing module", { session_id: "s-cli" });
  assert.match(p.json.hookSpecificOutput.additionalContext, /"done" or "skip"/);
  killPoller(ctx);
});
