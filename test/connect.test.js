// Hooks use the global CLI for sign-in and never install a private executable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, fixture, tmpdir, makeRepo, baseEnv, runHook, saveKey } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());

function setup() {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  return { data, repo: makeRepo().dir, env: baseEnv(data, fp.url) };
}

test("missing global CLI: SessionStart shows setup guidance once without downloading", async () => {
  const ctx = setup();
  ctx.env.PATH = "";
  const n = fp.state.requests.length;
  const r = await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /global intent-check CLI.*kit-onboarding/);
  assert.doesNotMatch(r.stdout, /wait|done.*skip|Before doing anything else/);
  assert.equal((await runHook("prompt", fixture("prompt", ctx.repo), ctx.env)).stdout, "");
  assert.equal(fp.state.requests.length, n);
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
  assert.equal(fs.existsSync(path.join(ctx.data, "bin")), false);
});

test("first prompt without a global CLI gives setup guidance without a private installation", async () => {
  const ctx = setup();
  ctx.env.PATH = "";
  const n = fp.state.requests.length;
  const r = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /kit-onboarding/);
  assert.equal(fp.state.requests.length, n);
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
});

test("until connected nothing is sent", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.equal(fp.jobRequests().length, n);
});

test("credentials saved by explicit onboarding are reused by later hooks", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  saveKey(ctx.data, TEST_KEY, fp.url);
  const p = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(p.json.systemMessage, "Intent Check connected");
  assert.equal((await runHook("prompt", fixture("prompt", ctx.repo), ctx.env)).stdout, "");
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  assert.equal((await runHook("stop", fixture("stop", ctx.repo), ctx.env)).code, 2);
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
});

test("INTENT_API_KEY needs no local installation or login", async () => {
  const ctx = setup();
  const r = await runHook("session-start", fixture("session-start", ctx.repo), { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  assert.equal(r.stdout, "");
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
  assert.equal(fs.existsSync(path.join(ctx.data, "bin")), false);
});
