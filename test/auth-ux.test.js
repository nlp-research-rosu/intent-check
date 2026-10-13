// Phase 3: plugin auth UX (keys per service, connect gate, connect-wait, state changes, commands,
// no silent failures), against the fake prover.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, PLUGIN_VERSION, ROOT, fixture, tmpdir, makeRepo, baseEnv, runHook, waitFor, saveKey, seedGlobal } from "./helpers/env.js";

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
const connectStatus = (ctx) => (fs.existsSync(cfileOf(ctx)) ? readJson(cfileOf(ctx)).status : null);
const prompt = (ctx, text = "please build the pricing module", extra = {}) => runHook("prompt", fixture("prompt", ctx.repo, { prompt: text, ...extra }), ctx.env);
const start = (ctx, extra = {}) => runHook("session-start", fixture("session-start", ctx.repo, extra), ctx.env);
const slash = (name, ctx, env = ctx.env) => runHook(name, undefined, env);

// ---- item 1: keys per service, legacy migration -------------------------------------------------

test("a legacy top-level api_key is moved under the current URL once /v1/me says 200, and stays readable", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY);
  const n = meCalls();
  const r = await start(ctx);
  assert.equal(r.stdout, "", "connected: nothing to show");
  assert.equal(meCalls(), n + 1);
  const cfg = readJson(path.join(ctx.data, "config.json"));
  assert.equal(cfg.keys[fp.url], TEST_KEY);
  assert.equal(cfg.api_key, undefined, "the old field is removed once its key lives under keys[url]");
  assert.equal(cfg.legacy_for, fp.url);
  assert.equal(fs.existsSync(cfileOf(ctx)), false);
  // Already under keys[url]: no second /v1/me.
  await prompt(ctx);
  assert.equal(meCalls(), n + 1);
});

test("a legacy key the service rejects is not migrated; the user gets a new link with the reason", async () => {
  const ctx = setup();
  saveKey(ctx.data, "ic_" + "Z".repeat(38));
  const r = await start(ctx);
  assert.match(r.json.systemMessage, /^Intent Check: Your saved key is no longer accepted \(revoked or expired\)\.\nIntent Check: connect your account → http/);
  const cfg = readJson(path.join(ctx.data, "config.json"));
  assert.equal(cfg.keys, undefined);
  assert.deepEqual(cfg.legacy_rejected, [fp.url]);
  const m = meCalls();
  await prompt(ctx, "another prompt that is long enough", { session_id: "s2" });
  assert.equal(meCalls(), m, "not asked again");
});

test("keys are per service: a key saved for another URL is not used", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, "http://127.0.0.1:1");
  const r = await start(ctx);
  assert.match(r.json.systemMessage, /connect your account/);
  assert.equal(readJson(cfileOf(ctx)).api_url, fp.url);
  const st = await slash("doctor", ctx);
  assert.match(st.stdout, /Key source: none/);
});

test("INTENT_API_KEY wins over a saved key, and doctor shows where the key comes from", async () => {
  const ctx = setup();
  saveKey(ctx.data, "ic_" + "Y".repeat(38), fp.url);
  const env = await slash("doctor", ctx, { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  assert.match(env.stdout, /Key source: INTENT_API_KEY \(environment\)/);
  assert.match(env.stdout, /Account: tester/, "the env key is the one asked");
});

// ---- item 3: connect creation off the prompt path, backoff -------------------------------------

test("429 from the service backs off for 30 s, then tries again", async () => {
  const ctx = setup();
  fp.state.connectStartStatus = 429;
  const r = await start(ctx);
  assert.match(r.json.systemMessage, /^Intent Check could not create a connect link \(429\)\. Run \/intent:doctor to retry\.$/);
  const g = () => readJson(path.join(ctx.data, "global.json"));
  assert.ok(g().backoff.connect > Date.now() - 5000);
  assert.match(g().last_error.text, /could not start a connect request \(429\)/);
  const n = posts();
  await start(ctx, { session_id: "s2" });
  assert.equal(posts(), n, "backed off: no request");
  fp.state.connectStartStatus = null;
  const old = Date.now() - 31000;
  seedGlobal(ctx.data, { backoff: { connect: old } });
  const again = await start(ctx, { session_id: "s3" });
  assert.equal(posts(), n + 1);
  assert.match(again.json.systemMessage, /connect your account/);
});

test("a timeout is not backed off: the next prompt tries again", async () => {
  const hang = http.createServer(() => { /* never answers */ });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const ctx = setup();
  const keep = { ...process.env };
  try {
    process.env.CLAUDE_PLUGIN_DATA = ctx.data;
    process.env.INTENT_API_URL = `http://127.0.0.1:${hang.address().port}`;
    delete process.env.INTENT_API_KEY;
    const { ensureRequest } = await import("../lib/connect.js");
    const c = await ensureRequest({ timeoutMs: 300 });
    assert.equal(c, null);
    const g = fs.existsSync(path.join(ctx.data, "global.json")) ? readJson(path.join(ctx.data, "global.json")) : {};
    assert.equal(g.backoff && g.backoff.connect, undefined);
    assert.match(g.last_error.text, /could not start a connect request/);
  } finally {
    for (const k of ["CLAUDE_PLUGIN_DATA", "INTENT_API_URL"]) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
    hang.closeAllConnections?.();
    await new Promise((r) => hang.close(r));
  }
});

// ---- item 4: connect-wait Stop hook -------------------------------------------------------------

test("connect-wait wakes the agent the moment the connection is approved", async () => {
  const ctx = setup();
  await start(ctx);
  const waiter = runHook("connect-wait", fixture("stop", ctx.repo), ctx.env, { timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  fp.state.connectApproved = true;
  const w = await waiter;
  assert.equal(w.code, 2);
  assert.match(w.stderr, /Intent Check connected as tester/);
  assert.deepEqual(w.json, { rewakeSummary: "Intent Check connected as tester" });
  // Announced once: the next prompt does not say it again.
  const p = await prompt(ctx);
  assert.equal(p.stdout, "");
});

test("connect-wait exits quietly when the user skipped, and in headless runs", async () => {
  const ctx = setup();
  await start(ctx);
  await prompt(ctx);
  await prompt(ctx, "skip");
  const w = await runHook("connect-wait", fixture("stop", ctx.repo), ctx.env, { timeoutMs: 20000 });
  assert.equal(w.code, 0);
  assert.equal(w.stdout + w.stderr, "");

  const ctx2 = setup();
  await start(ctx2);
  fp.state.connectApproved = true;
  const h = await runHook("connect-wait", fixture("stop", ctx2.repo), { ...ctx2.env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { timeoutMs: 20000 });
  assert.equal(h.code, 0, "claude -p would wait for it");
  assert.equal(h.stdout + h.stderr, "");
});

test("a connect reply after a host-injected block still counts", async () => {
  const ctx = setup();
  await start(ctx);
  await prompt(ctx);
  await prompt(ctx, "<browser_instruction>\n# Claude in Chrome browser automation\n</browser_instruction>\nskip");
  const w = await runHook("connect-wait", fixture("stop", ctx.repo), ctx.env, { timeoutMs: 20000 });
  assert.equal(w.code, 0);
  assert.equal(w.stdout + w.stderr, "");
});

test("connect-wait exits quietly when the request is denied; the next prompt explains", async () => {
  const ctx = setup();
  await start(ctx);
  fp.state.connectStatus = "denied";
  const w = await runHook("connect-wait", fixture("stop", ctx.repo), ctx.env, { timeoutMs: 30000 });
  assert.equal(w.code, 0);
  assert.equal(w.stdout + w.stderr, "");
  assert.equal(connectStatus(ctx), "denied");
});

test("only one waiter per request", async () => {
  const ctx = setup();
  await start(ctx);
  const a = runHook("connect-wait", fixture("stop", ctx.repo), ctx.env, { timeoutMs: 30000 });
  assert.ok(await waitFor(() => readJson(path.join(ctx.data, "connect.json")).waiter_pid > 0, { timeoutMs: 15000 }));
  const b = await runHook("connect-wait", fixture("stop", ctx.repo), ctx.env, { timeoutMs: 30000 });
  assert.equal(b.code, 0, "the second one leaves at once");
  fp.state.connectApproved = true;
  const first = await a;
  assert.equal(first.code, 2);
});

test("Codex has no wake: the confirmation arrives with the next prompt", async () => {
  const ctx = setup();
  const env = { ...ctx.env, PLUGIN_ROOT: ROOT };
  const s = await runHook("session-start", fixture("session-start", ctx.repo), env);
  assert.match(s.json.hookSpecificOutput.additionalContext, /connect your account → http/);
  const p1 = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "please build the pricing module" }), env);
  assert.doesNotMatch(p1.json.hookSpecificOutput.additionalContext, /confirms here by itself/);
  assert.match(p1.json.hookSpecificOutput.additionalContext, /"done" or "skip"/);
  fp.state.connectApproved = true;
  const cfg = path.join(ctx.data, "config.json");
  assert.ok(await waitFor(() => fs.existsSync(cfg) && (readJson(cfg).keys || {})[fp.url], { timeoutMs: 10000 }));
  const p2 = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "next thing please" }), env);
  assert.match(p2.json.hookSpecificOutput.additionalContext, /Intent Check connected as tester/);
});

// ---- item 5: state changes show the link again with a reason ------------------------------------

for (const [state, reason] of [["denied", /last connect request was denied/], ["expired", /last connect link expired/], ["consumed", /last connect link was already used/]]) {
  test(`${state} link: a new link is shown again with the reason`, async () => {
    const ctx = setup();
    await start(ctx);
    const first = readJson(cfileOf(ctx)).created_at;
    fp.state.connectStatus = state;
    assert.ok(await waitFor(() => connectStatus(ctx) === state, { timeoutMs: 10000 }));
    fp.state.connectStatus = null;
    const quiet = await prompt(ctx); // not live: the creator runs in the background
    assert.equal(quiet.stdout, "");
    assert.ok(await waitFor(() => connectStatus(ctx) === "pending" && readJson(cfileOf(ctx)).created_at !== first, { timeoutMs: 10000 }));
    assert.match(readJson(cfileOf(ctx)).reason, reason);
    const r = await prompt(ctx, "next request that is long enough");
    assert.match(r.json.systemMessage, /^Intent Check: [A-Z].*\nIntent Check: connect your account → http/);
    assert.match(r.json.systemMessage, reason);
    assert.match(r.json.hookSpecificOutput.additionalContext, reason);
    assert.match(r.json.hookSpecificOutput.additionalContext, /"done" or "skip"/);
  });
}

test("switching the service URL shows a new link with the reason", async () => {
  const ctx = setup();
  fs.writeFileSync(cfileOf(ctx), JSON.stringify({ status: "pending", api_url: "http://127.0.0.1:1", device_code: "x".repeat(32), verification_url: "http://127.0.0.1:1/c", expires_at: Date.now() + 600000, created_at: 5, interval_s: 1 }));
  const r = await start(ctx);
  assert.match(r.json.systemMessage, /The service changed to http:\/\/127\.0\.0\.1:\d+, so this machine needs a new connection/);
  assert.equal(readJson(cfileOf(ctx)).api_url, fp.url);
});

test("a 401 on submit forgets the saved key and prepares a new link with the reason", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  fp.state.keyRevoked = true;
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  const s = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(s.code, 0);
  const cfg = readJson(path.join(ctx.data, "config.json"));
  assert.equal((cfg.keys || {})[fp.url], undefined);
  assert.ok(await waitFor(() => connectStatus(ctx) === "pending", { timeoutMs: 10000 }));
  assert.match(readJson(cfileOf(ctx)).reason, /no longer accepted/);
  const r = await prompt(ctx, "carry on with the next task please");
  assert.match(r.json.systemMessage, /Your saved key is no longer accepted/);
  assert.match(r.json.systemMessage, /connect your account → http/);
});

// ---- item 8: poller race -----------------------------------------------------------------------

async function inProcess(ctx, fn) {
  const keep = { ...process.env };
  try {
    process.env.CLAUDE_PLUGIN_DATA = ctx.data;
    process.env.INTENT_API_URL = fp.url;
    delete process.env.INTENT_API_KEY;
    return await fn(await import("../lib/connect.js"), await import("../lib/config.js"));
  } finally {
    for (const k of ["CLAUDE_PLUGIN_DATA", "INTENT_API_URL", "INTENT_API_KEY"]) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
}

async function pendingRequest(ctx) {
  const r = await fetch(`${fp.url}/v1/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = await r.json();
  fs.writeFileSync(cfileOf(ctx), JSON.stringify({ status: "pending", api_url: fp.url, device_code: j.device_code, verification_url: j.verification_url, expires_at: Date.now() + 600000, created_at: 1, interval_s: 1, poller_pid: process.pid }));
}

test("poller race: two polls at once, the loser's 'consumed' never undoes the winner's approval", async () => {
  const ctx = setup();
  await pendingRequest(ctx);
  fp.state.connectApproved = true;
  await inProcess(ctx, async (c, cfg) => {
    const res = await Promise.all([c.checkConnectOnce(3000), c.checkConnectOnce(3000), c.checkConnectOnce(3000)]);
    assert.ok(res.includes("approved"));
    assert.equal(cfg.apiKey().key, TEST_KEY);
    const rec = c.readConnect();
    assert.equal(rec.status, "approved");
    assert.equal(rec.announce, true);
    assert.equal(rec.handle, "tester");
  });
});

test("the key is saved before anything is acknowledged: a failed save is never reported as connected", async () => {
  const ctx = setup();
  await pendingRequest(ctx);
  fs.mkdirSync(path.join(ctx.data, "config.json")); // saving the key will fail
  fp.state.connectApproved = true;
  await inProcess(ctx, async (c) => {
    const res = await c.checkConnectOnce(3000);
    assert.equal(res, "gone");
    const rec = c.readConnect();
    assert.equal(rec.status, "save_failed");
    assert.equal(rec.announce, undefined);
  });
});

// ---- item 6: commands ---------------------------------------------------------------------------

test("/intent:doctor: version, service, account, state, last check, last error, key source, update", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  const r = await slash("doctor", ctx);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], `Intent Check v${PLUGIN_VERSION}: on`);
  assert.equal(lines[1], `Service: ${fp.url}`);
  assert.equal(lines[2], "Account: tester (key ending BBBB)");
  assert.equal(lines[3], "State: connected");
  assert.equal(lines[4], "Key source: saved by Intent Check for this service");
  assert.equal(lines[5], "Last check: none yet");
  assert.equal(lines[6], "Last error: none");
  assert.match(lines[7], /^Local state: /);
  assert.equal(lines[8], "Update: skipped (this copy does not run from the plugin cache).");
  assert.match(lines[9], /^Nothing is being sent because no turn has changed source files/);
  assert.equal(lines.length, 10, "connected: no link, nothing to do");
  assert.doesNotMatch(r.stdout, new RegExp(TEST_KEY));
});

test("/intent:doctor explains why nothing was sent: not connected (with a link), off, and records the last check", async () => {
  const ctx = setup();
  const none = await slash("doctor", ctx);
  assert.match(none.stdout, /State: waiting for approval at http/);
  assert.match(none.stdout, /\nIntent Check: connect your account → http/);
  assert.match(none.stdout, /Account: none/);
  assert.match(none.stdout, /Nothing is being sent because this machine is not connected to an account yet\./);
  const off = await slash("doctor", ctx, { ...ctx.env, INTENT_DISABLED: "1" });
  assert.match(off.stdout, /Nothing is being sent because checks are off \(INTENT_DISABLED=1\)\./);
  assert.match(off.stdout, /To do: INTENT_DISABLED=1 is set in the environment/);
  assert.doesNotMatch(off.stdout, /connect your account/, "off: nothing to connect");

  // After a real submit the last check is recorded.
  saveKey(ctx.data, TEST_KEY, fp.url);
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  const sent = await slash("doctor", ctx);
  assert.match(sent.stdout, /Last check: \S+, sent/);
  assert.doesNotMatch(sent.stdout, /Nothing is being sent/);
  assert.match(sent.stdout, /\nEverything is working\.\n$/);
});

test("/intent:doctor gives a fresh link even after one was shown, and the next prompt does not repeat it", async () => {
  const ctx = setup();
  const s = await start(ctx);
  assert.match(s.json.systemMessage, /connect your account/);
  const before = posts();
  const c = await slash("doctor", ctx);
  assert.equal(c.code, 0);
  assert.match(c.stdout, /\nIntent Check: connect your account → http:\/\/127\.0\.0\.1:\d+\/connect\/KDRT-MWQX\n/);
  assert.equal(posts(), before + 1, "a fresh request");
  // The prompt that ran the command is what marks this session as the one that saw the link.
  await prompt(ctx, "/intent:doctor");
  const p = await prompt(ctx);
  assert.equal(p.stdout, "");
  // Another session did not see it: it still gets the line and the gate.
  const other = await prompt(ctx, "please build the pricing module", { session_id: "other-session" });
  assert.match(other.json.systemMessage, /connect your account/);
  assert.match(other.json.hookSpecificOutput.additionalContext, /"done" or "skip"/);
});

test("/intent:doctor when connected makes no connect request", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  const before = posts();
  const c = await slash("doctor", ctx);
  assert.match(c.stdout, /State: connected/);
  assert.doesNotMatch(c.stdout, /connect your account/);
  assert.equal(posts(), before);
});

test("/intent:doctor forgets a saved key the service rejects and shows a new link; an INTENT_API_KEY is left alone", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  fp.state.keyRevoked = true;
  const d = await slash("doctor", ctx);
  assert.equal(d.code, 0);
  assert.match(d.stdout, /Account: the service did not accept the key/);
  assert.match(d.stdout, /Key source: none/);
  assert.match(d.stdout, /\nIntent Check: connect your account → http/);
  assert.equal((readJson(path.join(ctx.data, "config.json")).keys || {})[fp.url], undefined);
  const env = await slash("doctor", ctx, { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  assert.match(env.stdout, /To do: The key in INTENT_API_KEY is not accepted/);
});

test("/intent:on and /intent:live turn checks on, set live, and show the connect link when there is no key", async () => {
  const ctx = setup();
  delete ctx.env.INTENT_LIVE;
  const cfg = () => readJson(path.join(ctx.data, "config.json"));
  await slash("off", ctx);
  assert.equal(cfg().disabled, true);
  const live = await slash("live", ctx);
  assert.match(live.stdout, /^Intent Check is on \(live\)\. Every edit is checked as it happens, and each turn at its end\.\nIntent Check: connect your account → http/);
  assert.deepEqual([cfg().disabled, cfg().live], [undefined, true]);
  assert.match((await slash("doctor", ctx)).stdout, /^Intent Check v\S+: on \(live\)\n/);
  saveKey(ctx.data, TEST_KEY, fp.url);
  const on = await slash("on", ctx);
  assert.equal(on.stdout, "Intent Check is on. Changes are checked at the end of each turn.\n");
  assert.equal(cfg().live, false);
  // The env var wins, and the command says so.
  const forced = await slash("on", ctx, { ...ctx.env, INTENT_LIVE: "1" });
  assert.match(forced.stdout, /INTENT_LIVE=1 is set in the environment and takes precedence\./);
});

test("hostUpdate: runs the host's two update commands and reports a newer installed version", async () => {
  const { hostUpdate, availableVersion, doctorCommand } = await import("../lib/commands.js");
  const dir = tmpdir("intent-cache-");
  fs.mkdirSync(path.join(dir, "0.2.3"));
  const info = { marketplace: "intentcomputing", plugin: "intent", version: "0.2.3", versionsDir: dir };
  const calls = [];
  const exec = async (file, args) => { calls.push([file, ...args].join(" ")); return true; };
  assert.equal(await hostUpdate({ info, exec }), "Update: up to date.");
  assert.deepEqual(calls, ["claude plugin marketplace update intentcomputing", "claude plugin update intent@intentcomputing"]);
  fs.mkdirSync(path.join(dir, "0.3.0"));
  assert.match(await hostUpdate({ info, exec }), /^Update: v0\.3\.0 is installed\. Run \/reload-plugins/);
  assert.match(await hostUpdate({ info, exec: async () => false }), /^Update: could not check from here .*To update by hand, open \/plugin/);
  // The host's local copy of the marketplace names a newer version: no network needed to say so.
  const home = tmpdir("intent-home-");
  const vdir = path.join(home, "plugins", "cache", "intentcomputing", "intent");
  fs.mkdirSync(path.join(vdir, "0.2.3"), { recursive: true });
  const mdir = path.join(home, "plugins", "marketplaces", "intentcomputing", ".claude-plugin");
  fs.mkdirSync(mdir, { recursive: true });
  const listed = (v) => fs.writeFileSync(path.join(mdir, "marketplace.json"), JSON.stringify({ name: "intentcomputing", plugins: [{ name: "intent", source: "./", version: v }] }));
  const inst = { ...info, versionsDir: vdir };
  const noTags = async () => "";
  fs.rmSync(path.dirname(mdir), { recursive: true });
  assert.equal(await availableVersion(inst, async () => "x\trefs/tags/v9.9.9\n"), null, "no marketplace copy: the remote is not asked");
  fs.mkdirSync(mdir, { recursive: true });
  listed("0.2.3");
  assert.equal(await availableVersion(inst, noTags), null, "not newer");
  // The local copy is stale: the remote's release tags name the newest one. Prerelease tags do not count.
  assert.equal(await availableVersion(inst, async () => ["a\trefs/tags/v0.2.3", "b\trefs/tags/v0.2.10", "c\trefs/tags/v0.4.0-per-edit.1", ""].join("\n")), "0.2.10");
  listed("0.3.0");
  assert.equal(await availableVersion(inst, noTags), "0.3.0");
  assert.match(await hostUpdate({ info: inst, exec: async () => false }), /^Update: v0\.3\.0 is available, but it could not be installed from here /);
  assert.match(await hostUpdate({ info: inst, exec }), /^Update: v0\.3\.0 is available but was not installed\./);
  // In-process: point it at a throwaway data folder, switched off so it calls nothing.
  const env = { CLAUDE_PLUGIN_DATA: tmpdir("intent-data-"), INTENT_API_URL: fp.url, INTENT_DISABLED: "1" };
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const out = await doctorCommand({ update: async () => "Update: x", available: () => "0.3.0" });
    assert.match(out, /^Intent Check v\S+ \(v0\.3\.0 available\): off \(INTENT_DISABLED=1\)\n/);
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.match(await hostUpdate({ info: null, exec }), /skipped/);
  assert.match(await hostUpdate({ host: "codex", info, exec }), /not checked on Codex/);
  assert.match(await hostUpdate({ info: { ...info, marketplace: "a;b" }, exec }), /could not check/);
});

// ---- item 7: no silent failures ---------------------------------------------------------------

test("the first run after install or update says Intent Check vX ready, once per version", async () => {
  const data = tmpdir("intent-data-");
  seedGlobal(data, { consent_shown_at: "x" });
  const env = { ...baseEnv(data, fp.url), INTENT_API_KEY: TEST_KEY };
  const repo = makeRepo().dir;
  const a = await runHook("session-start", fixture("session-start", repo), env);
  assert.equal(a.json.systemMessage, `Intent Check v${PLUGIN_VERSION} ready`);
  const b = await runHook("session-start", fixture("session-start", repo, { session_id: "s2" }), env);
  assert.equal(b.stdout, "");
  seedGlobal(data, { ready_version: "0.0.1" }); // an update
  const c = await runHook("prompt", fixture("prompt", repo), env);
  assert.equal(c.json.systemMessage, `Intent Check v${PLUGIN_VERSION} ready`);
});

test("a hook that throws prints one user-visible line per session, and doctor shows why", async () => {
  const ctx = setup();
  fs.mkdirSync(path.join(ctx.data, "connect.json", "x"), { recursive: true }); // the request cannot be saved
  const a = await start(ctx, { session_id: "boom" });
  assert.equal(a.code, 0);
  assert.match(a.json.systemMessage, /^Intent Check hit an error \(\w+\) and may not be checking your changes\. Run \/intent:doctor to check and repair it\.$/);
  const b = await start(ctx, { session_id: "boom" });
  assert.equal(b.stdout, "", "once per session");
  const other = await start(ctx, { session_id: "another" });
  assert.match(other.json.systemMessage, /hit an error/);
  const st = await slash("doctor", ctx);
  assert.match(st.stdout, /Last error: session-start: /);
});

test("bin/intent.js says so on stderr when the plugin cannot start, and still exits 0", async () => {
  const dir = tmpdir("intent-bin-");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.copyFileSync(path.join(ROOT, "bin", "intent.js"), path.join(dir, "bin", "intent.js"));
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [path.join(dir, "bin", "intent.js"), "prompt"], { input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^Intent Check could not start \(\w+\), so it is not running\./);
});

test("bin/intent.js on Node < 18: the stderr line appears once per data dir, exit 0 every time", async () => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const data = path.join(tmpdir("intent-oldnode-"), "data");
  const shim = path.join(tmpdir("intent-oldnode-shim-"), "shim.mjs");
  fs.writeFileSync(shim, `Object.defineProperty(process.versions, "node", { value: "16.1.0" });\nawait import(${JSON.stringify(pathToFileURL(path.join(ROOT, "bin", "intent.js")).href)});\n`);
  const run = (env) => spawnSync(process.execPath, [shim, "prompt"], { input: "{}", encoding: "utf8", env: { ...process.env, ...env } });
  const a = run({ CLAUDE_PLUGIN_DATA: data });
  assert.equal(a.status, 0);
  assert.equal(a.stderr, "Intent Check needs Node 18 or newer (found 16.1.0), so it is not running. Update Node to use it.\n");
  assert.deepEqual(JSON.parse(a.stdout), { systemMessage: "Intent Check needs Node.js 18 or newer to run (found 16.1.0). Install it from nodejs.org, then run /reload-plugins." });
  assert.ok(fs.existsSync(path.join(data, ".node-too-old-16.1.0")));
  const b = run({ CLAUDE_PLUGIN_DATA: data });
  assert.equal(b.status, 0);
  assert.equal(b.stderr, "");
  assert.equal(b.stdout, "");
  // Other hooks stay silent and do not use up the one message; Codex gets its own restart wording.
  const quiet = spawnSync(process.execPath, [shim, "post-tool"], { input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(data, "q") } });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "");
  assert.ok(!fs.existsSync(path.join(data, "q", ".node-too-old-16.1.0")));
  const cx = spawnSync(process.execPath, [shim, "session-start", "--host", "codex"], { input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(data, "q") } });
  const cxo = JSON.parse(cx.stdout);
  assert.equal(cxo.systemMessage, undefined);
  assert.equal(cxo.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(cxo.hookSpecificOutput.additionalContext, /^Intent Check needs Node\.js 18 or newer to run \(found 16\.1\.0\)\. Install it from nodejs\.org, then restart Codex\.$/);
  const cp = spawnSync(process.execPath, [shim, "prompt", "--host", "codex"], { input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(data, "q2") } });
  assert.equal(JSON.parse(cp.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
  // With no data dir there is nowhere to remember it: say it every time rather than never.
  const c = run({ CLAUDE_PLUGIN_DATA: "", PLUGIN_DATA: "" });
  assert.equal(c.status, 0);
  assert.match(c.stderr, /needs Node 18 or newer/);
});

test("bin/intent.js names the Node requirement in the same stderr line style", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin", "intent.js"), "utf8");
  assert.match(src.split("\n")[0], /Intent Check needs Node 18 or newer/);
  assert.doesNotMatch(src.split("\n")[0], /\?\.|\?\?/, "line 1 stays old syntax");
});

// ---- a 401 acts on the key that was sent, not on whatever is current ------------------------------

test("a key re-saved between the request and its 401 survives; a second 401 for the cleared key is silent", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  const { handleSubmitFailure } = await import("../lib/runner.js");
  const { saveApiKey, apiKey } = await import("../lib/config.js");
  const { loadSession } = await import("../lib/state.js");
  const { pausedFor } = await import("../lib/pause.js");
  const NEW = "ic_" + "N".repeat(38);
  await inProcess(ctx, async () => {
    // The user connected a new key while a request sent with the old one was still in flight.
    saveApiKey(NEW);
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, TEST_KEY);
    assert.equal(apiKey().key, NEW);
    assert.equal(fs.existsSync(cfileOf(ctx)), false, "no revoke flow for a key that is no longer current");
    // Two requests sent with the same key both fail: the first clears it, the second does nothing.
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, NEW);
    assert.equal(apiKey().key, null);
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, NEW);
    assert.doesNotMatch(JSON.stringify(loadSession("sess").notes), /INTENT_API_KEY/);
    assert.ok(pausedFor(NEW), "paused for the key that was sent, never for a missing one");
  });
});

test("an env-key 401 notes INTENT_API_KEY, pauses that key and leaves it alone", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  const { handleSubmitFailure } = await import("../lib/runner.js");
  const { loadSession } = await import("../lib/state.js");
  const { pausedFor } = await import("../lib/pause.js");
  const ENV = "ic_" + "E".repeat(38);
  await inProcess(ctx, async () => {
    process.env.INTENT_API_KEY = ENV;
    try {
      handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, ENV);
    } finally { delete process.env.INTENT_API_KEY; }
    assert.match(JSON.stringify(loadSession("sess").notes), /INTENT_API_KEY was not accepted/);
    assert.ok(pausedFor(ENV));
  });
  assert.equal(readJson(path.join(ctx.data, "config.json")).keys[fp.url], TEST_KEY, "saved key untouched");
});
