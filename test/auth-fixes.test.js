// Fix round for the auth UX: concurrent creation, heartbeats, visible creation
// failures, SessionStart budget, server text limits, state holes, headless.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { isPidAlive } from "../lib/fsutil.js";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, FAKE_CLI, fixture, tmpdir, makeRepo, baseEnv, runHook, waitFor, saveKey, seedGlobal, xdgDir, savedKey } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { connectApproved: false, connectKeyTaken: false, connectStatus: null, connectStartStatus: null, keyRevoked: false, key: TEST_KEY, handle: "tester", pollsBeforeDone: 0, scenario: "concerns", verifyUrl: null, connectStartDelayMs: 0, tasksStatus: null, pollStatus: null }));

function setup() {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  return { data, repo: makeRepo().dir, env: baseEnv(data, fp.url) };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const cfileOf = (ctx) => path.join(ctx.data, "connect.json");
const posts = () => fp.state.requests.filter((x) => x.method === "POST" && x.path === "/api/cli-connect" && x.body && x.body.action === "start").length;
const keyChecks = () => fp.state.requests.filter((x) => x.path === "/tasks" && x.method === "GET").length;
const prompt = (ctx, text = "please build the pricing module", extra = {}, env = ctx.env) => runHook("prompt", fixture("prompt", ctx.repo, { prompt: text, ...extra }), env);
const start = (ctx, extra = {}) => runHook("session-start", fixture("session-start", ctx.repo, extra), ctx.env);

// Run lib code in this process against a temp data dir and the fake prover, then restore the env.
async function inProcess(ctx, fn, extraEnv = {}) {
  const keys = ["CLAUDE_PLUGIN_DATA", "XDG_CONFIG_HOME", "INTENT_API_URL", "INTENT_CONSOLE_URL", "INTENT_API_KEY", "INTENT_CLAIM", "INTENT_CLI_PATH", "INTENT_CLI_BASE_URL", ...Object.keys(extraEnv)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  delete process.env.INTENT_API_KEY;
  delete process.env.INTENT_CLAIM;
  delete process.env.INTENT_CLI_BASE_URL;
  Object.assign(process.env, { INTENT_CLI_PATH: FAKE_CLI, CLAUDE_PLUGIN_DATA: ctx.data, XDG_CONFIG_HOME: xdgDir(ctx.data), INTENT_API_URL: fp.url, INTENT_CONSOLE_URL: fp.url, ...extraEnv });
  try {
    return await fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const killPoller = (ctx) => { try { process.kill(readJson(cfileOf(ctx)).poller_pid, "SIGKILL"); } catch { /* gone */ } };

// ---- 2: one request, even when two callers race --------------------------------------------------

test("two concurrent ensureRequest calls make one record, and the link returned is the one being watched", async () => {
  const ctx = setup();
  fp.state.connectStartDelayMs = 400;
  const n = posts();
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    const [a, b] = await Promise.all([c.ensureRequest({ timeoutMs: 5000 }), c.ensureRequest({ timeoutMs: 5000 })]);
    assert.ok(a && b, "both callers get the live request");
    assert.equal(a.created_at, b.created_at);
    assert.equal(a.verification_url, b.verification_url);
    assert.equal(posts(), n + 1, "one start request");
    assert.equal(readJson(cfileOf(ctx)).poller_pid, a.poller_pid, "stored = the login process that is running");
    assert.ok(isPidAlive(a.poller_pid));
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
    // (20 ms apart: the output file is named by the millisecond the login started.)
    const [a, b] = await Promise.all([c.ensureRequest({ timeoutMs: 5000, claim: 1 }), new Promise((r) => setTimeout(r, 20)).then(() => c.ensureRequest({ timeoutMs: 5000, claim: 1 }))]);
    assert.equal(posts(), n + 2);
    assert.equal(a.created_at, b.created_at, "both return the record that was kept");
    assert.equal(readJson(cfileOf(ctx)).created_at, a.created_at);
    assert.ok(await waitFor(() => fs.readdirSync(ctx.data).filter((f) => f.startsWith("connect-login-")).length === 1), "the loser's output file is gone");
    // A forced request does replace it, and ends the previous login.
    const f = await c.ensureRequest({ timeoutMs: 5000, force: true });
    assert.notEqual(f.created_at, a.created_at);
    assert.ok(await waitFor(() => !isPidAlive(a.poller_pid)), "the previous login was killed");
    assert.ok(isPidAlive(f.poller_pid));
    killPoller(ctx);
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

test("a live pid with an old heartbeat is not a live waiter", async () => {
  const c = await import("../lib/connect.js");
  const now = Date.now();
  const rec = (at) => ({ status: "pending", waiter_pid: process.ppid, waiter_at: at });
  assert.equal(c.holderAlive(rec(now - 1000), "waiter", now), true);
  assert.equal(c.holderAlive(rec(now - 20000), "waiter", now), false, "older than 15 s");
  assert.equal(c.holderAlive({ ...rec(now), waiter_at: undefined }, "waiter", now), false, "no heartbeat at all");
  assert.equal(c.holderAlive({ waiter_pid: 999999, waiter_at: now }, "waiter", now), false, "dead pid");
});

// ---- the CLI is not on disk: the creator downloads it, never the hook ----------------------------

test("no CLI on disk: the hook only starts the creator; a failed download is a connect failure told once", async () => {
  const ctx = setup();
  const env = { ...ctx.env, INTENT_CLI_BASE_URL: "http://127.0.0.1:1" };
  delete env.INTENT_CLI_PATH;
  const n = posts();
  const s = await runHook("session-start", fixture("session-start", ctx.repo), env);
  assert.doesNotMatch(s.stdout, /connect your account/);
  assert.equal(fs.existsSync(cfileOf(ctx)), false);
  const g = () => readJson(path.join(ctx.data, "global.json"));
  assert.ok(await waitFor(() => g().connect_fail, { timeoutMs: 15000 }), "the creator ran and failed to download");
  assert.equal(g().connect_fail.code, "download");
  assert.ok(g().backoff.connect, "backed off");
  const p = await runHook("prompt", fixture("prompt", ctx.repo), env);
  assert.match(p.json.systemMessage, /could not create a connect link \(download\)/);
  assert.equal(posts(), n, "no sign-in was started");
  assert.equal(fs.existsSync(path.join(ctx.data, "bin")), false);
});

// ---- 4: creation failures are visible and backed off ---------------------------------------------

for (const status of [404, 400, 403, 408]) {
  test(`creating the link fails with ${status}: one visible line per session, backed off`, async () => {
    const ctx = setup();
    fp.state.connectStartStatus = status;
    const s = await start(ctx);
    assert.equal(s.json.systemMessage, `Intent Check could not create a connect link (login). Run /intent:doctor to retry.`);
    assert.equal(Boolean(readJson(path.join(ctx.data, "global.json")).backoff && readJson(path.join(ctx.data, "global.json")).backoff.connect), true);
    const p = await prompt(ctx);
    assert.equal(p.stdout, "", "once per session");
    const n = posts();
    await prompt(ctx, "another request please", { session_id: "s2" });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(posts(), n, "no process respawned on every prompt");
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

for (const [name, body] of [["a user code of the wrong shape", { user_code: "kdrt-mwqx" }], ["a lifetime over 900 s", { expires_in: 5000 }]]) {
  test(`${name} in the CLI's first line is refused: the start counts as failed`, async () => {
    const ctx = setup();
    fp.state.connectStartBody = body;
    try {
      const s = await start(ctx);
      assert.match(s.json.systemMessage, /could not create a connect link \(login\)/);
      assert.equal(fs.existsSync(cfileOf(ctx)), false);
    } finally { fp.state.connectStartBody = null; }
  });
}

// ---- 8: state holes ------------------------------------------------------------------------------

test("a key for this service appears: approved and announced once, by whoever sees it first", async () => {
  const ctx = setup();
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    await c.ensureRequest();
    fp.state.connectApproved = true;
    assert.ok(await waitFor(() => savedKey(ctx.data, fp.url) === TEST_KEY, { timeoutMs: 10000 }));
    assert.equal(c.checkConnectOnce(), "approved");
    assert.equal(c.checkConnectOnce(), "none", "no longer pending");
    const rec = readJson(cfileOf(ctx));
    assert.deepEqual([rec.status, rec.announce], ["approved", true]);
    assert.equal(c.takeConnectedAnnouncement(), true);
    assert.equal(c.takeConnectedAnnouncement(), null, "once");
  });
});

for (const [name, lines, status] of [
  ["denied", '{"status":"pending"}\n{"status":"denied"}\n', "denied"],
  ["expired", '{"status":"expired"}\n', "expired"],
  ["consumed", '{"status":"consumed"}\n', "consumed"],
  ["no result line", '{"status":"pending"}\n', "failed"],
  ["a failure line", '{"status":"failure","message":"x"}\n', "failed"],
  ["an unknown status", '{"status":"weird"}\n', "failed"],
  ["no output file", null, "failed"],
]) {
  test(`the CLI died without a key (${name}): the status comes from its last output line`, async () => {
    const ctx = setup();
    fs.writeFileSync(cfileOf(ctx), JSON.stringify({ status: "pending", api_url: fp.url, user_code: "KDRT-MWQX", verification_url: `${fp.url}/connect/KDRT-MWQX`, expires_at: Date.now() + 600000, created_at: 7, poller_pid: 999999 }));
    if (lines !== null) fs.writeFileSync(path.join(ctx.data, "connect-login-7.out"), lines);
    await inProcess(ctx, async () => {
      const c = await import("../lib/connect.js");
      assert.equal(c.checkConnectOnce(), "gone");
      assert.equal(readJson(cfileOf(ctx)).status, status);
      assert.equal(readJson(cfileOf(ctx)).announce, undefined);
    });
  });
}

test("a login that is still running with no key stays pending", async () => {
  const ctx = setup();
  fs.writeFileSync(cfileOf(ctx), JSON.stringify({ status: "pending", api_url: fp.url, expires_at: Date.now() + 600000, created_at: 7, poller_pid: process.pid }));
  await inProcess(ctx, async () => {
    const c = await import("../lib/connect.js");
    assert.equal(c.checkConnectOnce(), "pending");
    assert.equal(readJson(cfileOf(ctx)).status, "pending");
  });
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
