// Shared credentials, explicit onboarding guidance, doctor and host updates.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, PLUGIN_VERSION, ROOT, fixture, tmpdir, makeRepo, baseEnv, runHook, saveKey, seedGlobal, xdgDir, savedKey, credentialsPath } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { keyRevoked: false, key: TEST_KEY, pollsBeforeDone: 0, scenario: "concerns", tasksStatus: null, pollStatus: null }));

function setup() {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  return { data, repo: makeRepo().dir, env: baseEnv(data, fp.url) };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const posts = () => fp.state.requests.filter((x) => x.method === "POST" && x.path === "/api/cli-connect").length;
const start = (ctx, extra = {}) => runHook("session-start", fixture("session-start", ctx.repo, extra), ctx.env);
const slash = (name, ctx, env = ctx.env) => runHook(name, undefined, env);

async function inProcess(ctx, fn) {
  const keep = { ...process.env };
  try {
    process.env.CLAUDE_PLUGIN_DATA = ctx.data;
    process.env.XDG_CONFIG_HOME = xdgDir(ctx.data);
    process.env.INTENT_API_URL = process.env.INTENT_CONSOLE_URL = fp.url;
    delete process.env.INTENT_API_KEY;
    return await fn();
  } finally {
    for (const k of ["CLAUDE_PLUGIN_DATA", "XDG_CONFIG_HOME", "INTENT_API_URL", "INTENT_CONSOLE_URL", "INTENT_API_KEY"]) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
}

test("keys are per service: a key saved for another URL is not used", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, "http://127.0.0.1:1");
  const r = await start(ctx);
  assert.match(r.json.systemMessage, /kit-onboarding/);
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
  assert.match((await slash("doctor", ctx)).stdout, /Key source: none/);
});

test("INTENT_API_KEY wins over a saved key, and doctor shows where the key comes from", async () => {
  const ctx = setup();
  saveKey(ctx.data, "ic_" + "Y".repeat(38), fp.url);
  const env = await slash("doctor", ctx, { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  assert.match(env.stdout, /Key source: INTENT_API_KEY \(environment\)/);
  assert.match(env.stdout, /Account: key accepted/);
});

test("/intent:doctor reports version, service, account, state, last check, last error, key source and update", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  const r = await slash("doctor", ctx);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(0, 7), [
    `Intent Check v${PLUGIN_VERSION}: on`, `Service: ${fp.url}`, "Account: key accepted", "State: connected",
    `Key source: ${credentialsPath(ctx.data)}, ending ${TEST_KEY.slice(-4)}`, "Last check: none yet", "Last error: none",
  ]);
  assert.match(lines[7], /^Local state: /);
  assert.equal(lines[8], "Update: skipped (this copy does not run from the plugin cache).");
  assert.match(lines[9], /^Nothing is being sent because no turn has changed source files/);
  assert.equal(lines.length, 10);
  assert.doesNotMatch(r.stdout, new RegExp(TEST_KEY));
});

test("/intent:doctor names a credentials file others can read", { skip: process.platform === "win32" }, async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  fs.chmodSync(credentialsPath(ctx.data), 0o644);
  const d = await slash("doctor", ctx);
  assert.match(d.stdout, /To do: .*credentials\.json: the credentials file is readable by others; run chmod 600 on it\./);
  assert.match(d.stdout, /Key source: none/);
});

test("/intent:doctor explains why nothing was sent: not connected, off, and records the last check", async () => {
  const ctx = setup();
  const none = await slash("doctor", ctx);
  assert.match(none.stdout, /State: not connected/);
  assert.match(none.stdout, /kit-onboarding.*intent-check login/);
  assert.match(none.stdout, /Account: none/);
  assert.match(none.stdout, /Nothing is being sent because this machine is not connected to an account yet\./);
  const off = await slash("doctor", ctx, { ...ctx.env, INTENT_DISABLED: "1" });
  assert.match(off.stdout, /Nothing is being sent because checks are off \(INTENT_DISABLED=1\)\./);
  assert.match(off.stdout, /To do: INTENT_DISABLED=1 is set in the environment/);
  assert.doesNotMatch(off.stdout, /kit-onboarding/);
  saveKey(ctx.data, TEST_KEY, fp.url);
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  const sent = await slash("doctor", ctx);
  assert.match(sent.stdout, /Last check: \S+, sent/);
  assert.match(sent.stdout, /\nEverything is working\.\n$/);
});

test("/intent:doctor does not start login, whether connected or not", async () => {
  const ctx = setup();
  const before = posts();
  assert.match((await slash("doctor", ctx)).stdout, /intent-check login/);
  saveKey(ctx.data, TEST_KEY, fp.url);
  assert.match((await slash("doctor", ctx)).stdout, /State: connected/);
  assert.equal(posts(), before);
});

test("/intent:doctor forgets a rejected saved key and asks for explicit sign-in; an environment key is left alone", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  fp.state.keyRevoked = true;
  const d = await slash("doctor", ctx);
  assert.equal(d.code, 0);
  assert.match(d.stdout, /Account: the service did not accept the key/);
  assert.match(d.stdout, /Key source: none/);
  assert.match(d.stdout, /intent-check login/);
  assert.equal(savedKey(ctx.data, fp.url), undefined);
  assert.match((await slash("doctor", ctx, { ...ctx.env, INTENT_API_KEY: TEST_KEY })).stdout, /To do: The key in INTENT_API_KEY is not accepted/);
});

test("/intent:on and /intent:live save preferences and give setup guidance without a key", async () => {
  const ctx = setup();
  delete ctx.env.INTENT_LIVE;
  const cfg = () => readJson(path.join(ctx.data, "config.json"));
  await slash("off", ctx);
  assert.equal(cfg().disabled, true);
  const live = await slash("live", ctx);
  assert.match(live.stdout, /^Intent Check is on \(live\)\./);
  assert.match(live.stdout, /kit-onboarding.*intent-check login/);
  assert.deepEqual([cfg().disabled, cfg().live], [undefined, true]);
  saveKey(ctx.data, TEST_KEY, fp.url);
  assert.equal((await slash("on", ctx)).stdout, "Intent Check is on. Changes are checked at the end of each turn. Live review is now off; /intent:live turns it back on.\n");
  assert.equal(cfg().live, false);
  assert.match((await slash("on", ctx, { ...ctx.env, INTENT_LIVE: "1" })).stdout, /INTENT_LIVE=1 is set in the environment and takes precedence\./);
});

test("hostUpdate runs the host's two update commands and reports available and installed versions", async () => {
  const { hostUpdate, availableVersion } = await import("../lib/commands.js");
  const home = tmpdir("intent-home-");
  const vdir = path.join(home, "plugins", "cache", "intentcomputing", "intent");
  fs.mkdirSync(path.join(vdir, "0.2.3"), { recursive: true });
  const info = { marketplace: "intentcomputing", plugin: "intent", version: "0.2.3", versionsDir: vdir };
  const calls = [];
  const exec = async (file, args) => { calls.push([file, ...args].join(" ")); return true; };
  assert.equal(await hostUpdate({ info, exec }), "Update: up to date.");
  assert.deepEqual(calls, ["claude plugin marketplace update intentcomputing", "claude plugin update intent@intentcomputing"]);
  fs.mkdirSync(path.join(vdir, "0.3.0"));
  assert.match(await hostUpdate({ info, exec }), /^Update: v0\.3\.0 is installed\. Run \/reload-plugins/);
  fs.rmdirSync(path.join(vdir, "0.3.0"));
  assert.match(await hostUpdate({ info, exec: async () => false }), /^Update: could not check from here/);
  assert.equal(await availableVersion(info, async () => "x\trefs/tags/v9.9.9\n"), null);
  const mdir = path.join(home, "plugins", "marketplaces", "intentcomputing", ".claude-plugin");
  fs.mkdirSync(mdir, { recursive: true });
  const listed = (v) => fs.writeFileSync(path.join(mdir, "marketplace.json"), JSON.stringify({ plugins: [{ name: "intent", version: v }] }));
  listed("0.2.3");
  assert.equal(await availableVersion(info, async () => ""), null);
  assert.equal(await availableVersion(info, async () => "a\trefs/tags/v0.2.3\nb\trefs/tags/v0.2.10\nc\trefs/tags/v0.4.0-per-edit.1\n"), "0.2.10");
  listed("0.3.0");
  assert.equal(await availableVersion(info, async () => ""), "0.3.0");
  assert.match(await hostUpdate({ info, exec: async () => false }), /^Update: v0\.3\.0 is available, but it could not be installed/);
  assert.match(await hostUpdate({ info, exec }), /^Update: v0\.3\.0 is available but was not installed/);
  assert.match(await hostUpdate({ info: null, exec }), /skipped/);
  assert.match(await hostUpdate({ host: "codex", info, exec }), /not checked on Codex/);
  assert.match(await hostUpdate({ info: { ...info, marketplace: "a;b" }, exec }), /could not check/);
});

test("the first run after install or update says Intent Check vX ready, once per version", async () => {
  const data = tmpdir("intent-data-");
  seedGlobal(data, { consent_shown_at: "x" });
  const env = { ...baseEnv(data, fp.url), INTENT_API_KEY: TEST_KEY };
  const repo = makeRepo().dir;
  assert.equal((await runHook("session-start", fixture("session-start", repo), env)).json.systemMessage, `Intent Check v${PLUGIN_VERSION} ready`);
  assert.equal((await runHook("session-start", fixture("session-start", repo, { session_id: "s2" }), env)).stdout, "");
  seedGlobal(data, { ready_version: "0.0.1" });
  assert.equal((await runHook("prompt", fixture("prompt", repo), env)).json.systemMessage, `Intent Check v${PLUGIN_VERSION} ready`);
});

test("bin/hooks.js says so on stderr when the plugin cannot start, and still exits 0", async () => {
  const dir = tmpdir("intent-bin-");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.copyFileSync(path.join(ROOT, "bin", "hooks.js"), path.join(dir, "bin", "hooks.js"));
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [path.join(dir, "bin", "hooks.js"), "prompt"], { input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^Intent Check could not start \(\w+\), so it is not running\./);
});

test("bin/hooks.js on Node < 18 reports the requirement once per data dir", async () => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const data = path.join(tmpdir("intent-oldnode-"), "data");
  const shim = path.join(tmpdir("intent-oldnode-shim-"), "shim.mjs");
  fs.writeFileSync(shim, `Object.defineProperty(process.versions, "node", { value: "16.1.0" });\nawait import(${JSON.stringify(pathToFileURL(path.join(ROOT, "bin", "hooks.js")).href)});\n`);
  const run = (env) => spawnSync(process.execPath, [shim, "prompt"], { input: "{}", encoding: "utf8", env: { ...process.env, ...env } });
  const a = run({ CLAUDE_PLUGIN_DATA: data });
  assert.equal(a.status, 0);
  assert.equal(a.stderr, "Intent Check needs Node 18 or newer (found 16.1.0), so it is not running. Update Node to use it.\n");
  assert.match(JSON.parse(a.stdout).systemMessage, /Node\.js 18 or newer/);
  assert.ok(fs.existsSync(path.join(data, ".node-too-old-16.1.0")));
  assert.equal(run({ CLAUDE_PLUGIN_DATA: data }).stdout, "");
  const quiet = spawnSync(process.execPath, [shim, "post-tool"], { input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(data, "q") } });
  assert.equal(quiet.stdout, "");
  assert.ok(!fs.existsSync(path.join(data, "q", ".node-too-old-16.1.0")));
  const cx = spawnSync(process.execPath, [shim, "session-start", "--host", "codex"], { input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(data, "q") } });
  assert.equal(JSON.parse(cx.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(JSON.parse(cx.stdout).hookSpecificOutput.additionalContext, /restart Codex\.$/);
  assert.match(run({ CLAUDE_PLUGIN_DATA: "", PLUGIN_DATA: "" }).stderr, /needs Node 18 or newer/);
});

test("bin/hooks.js names the Node requirement in the same stderr line style", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin", "hooks.js"), "utf8");
  assert.match(src.split("\n")[0], /Intent Check needs Node 18 or newer/);
  assert.doesNotMatch(src.split("\n")[0], /\?\.|\?\?/);
});

test("a key re-saved before a 401 survives; a second 401 for the cleared key is silent", async () => {
  const ctx = setup();
  const { handleSubmitFailure } = await import("../lib/runner.js");
  const { apiKey } = await import("../lib/config.js");
  const { loadSession } = await import("../lib/state.js");
  const { pausedFor } = await import("../lib/pause.js");
  const fresh = "ic_" + "N".repeat(38);
  await inProcess(ctx, async () => {
    saveKey(ctx.data, fresh, fp.url);
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, TEST_KEY);
    assert.equal(apiKey().key, fresh);
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, fresh);
    assert.equal(apiKey().key, null);
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, fresh);
    assert.doesNotMatch(JSON.stringify(loadSession("sess").notes), /INTENT_API_KEY/);
    assert.ok(pausedFor(fresh));
    assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
  });
});

test("an env-key 401 notes INTENT_API_KEY, pauses that key and leaves the saved key alone", async () => {
  const ctx = setup();
  saveKey(ctx.data, TEST_KEY, fp.url);
  const { handleSubmitFailure } = await import("../lib/runner.js");
  const { loadSession } = await import("../lib/state.js");
  const { pausedFor } = await import("../lib/pause.js");
  const env = "ic_" + "E".repeat(38);
  await inProcess(ctx, async () => {
    process.env.INTENT_API_KEY = env;
    handleSubmitFailure("sess", { status: 401, code: "unauthorized" }, { touched: [] }, env);
    assert.match(JSON.stringify(loadSession("sess").notes), /INTENT_API_KEY was not accepted/);
    assert.ok(pausedFor(env));
  });
  assert.equal(savedKey(ctx.data, fp.url), TEST_KEY);
});

test("doctor skips the host update while checks are off, and looks up the newest version once", async () => {
  const ctx = setup();
  const { doctorCommand } = await import("../lib/commands.js");
  await inProcess(ctx, async () => {
    const previous = process.env.INTENT_DISABLED;
    let updates = 0;
    let lookups = 0;
    const update = async ({ available }) => { updates++; await available(); await available(); return "Update: x"; };
    const available = () => { lookups++; return "0.3.0"; };
    try {
      process.env.INTENT_DISABLED = "1";
      const off = await doctorCommand({ update, available });
      assert.deepEqual([updates, lookups, /Update:/.test(off)], [0, 1, false]);
      delete process.env.INTENT_DISABLED;
      updates = lookups = 0;
      assert.match(await doctorCommand({ update, available }), /\nUpdate: x\n/);
      assert.deepEqual([updates, lookups], [1, 1]);
    } finally { if (previous === undefined) delete process.env.INTENT_DISABLED; else process.env.INTENT_DISABLED = previous; }
  });
});
