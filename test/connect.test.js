// Connect-link onboarding against the fake prover.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, fixture, tmpdir, makeRepo, baseEnv, runHook, waitFor } from "./helpers/env.js";
import { validateDef } from "./helpers/schema.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { connectApproved: false, connectKeyTaken: false, connectStatus: null, connectStartStatus: null, keyRevoked: false, key: TEST_KEY, handle: "tester", pollsBeforeDone: 0, scenario: "concerns" }));

function setup() {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  return { data, repo: makeRepo().dir, env: baseEnv(data, fp.url) };
}

const mode = (f) => fs.statSync(f).mode & 0o777;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const posts = () => fp.state.requests.filter((x) => x.method === "POST" && x.path === "/v1/connect").length;
const LINK = /http:\/\/127\.0\.0\.1:\d+\/connect\/KDRT-MWQX/;

test("no key: SessionStart creates the request and shows the link; the prompt tells the agent to wait for done or skip", async () => {
  const ctx = setup();
  const n = fp.state.requests.length;
  const r = await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /^Intent Check: connect your account → http:\/\/127\.0\.0\.1:\d+\/connect\/KDRT-MWQX$/);
  const start = fp.state.requests.slice(n).find((x) => x.method === "POST" && x.path === "/v1/connect");
  assert.deepEqual(validateDef(start.body, "ConnectStart"), []);
  assert.equal(start.body.host, "claude-code");
  const cfile = path.join(ctx.data, "connect.json");
  assert.equal(mode(cfile), 0o600);
  const c = readJson(cfile);
  assert.equal(c.api_url, fp.url, "connect.json records the service");
  assert.ok(c.poller_pid > 0);

  const before = posts();
  const p = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(p.json.systemMessage, undefined, "the link line was already shown this session");
  const ctxText = p.json.hookSpecificOutput.additionalContext;
  assert.match(ctxText, LINK);
  assert.match(ctxText, /show the user this connect link/);
  assert.match(ctxText, /"done" or "skip"/);
  assert.equal(posts(), before, "the prompt hook does not create requests");

  const again = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(again.stdout, "", "once per session");

  // A new session shows the same pending link without a second connect request.
  const other = await runHook("prompt", fixture("prompt", ctx.repo, { session_id: "another-session" }), ctx.env);
  assert.match(other.json.systemMessage, /connect your account/);
  assert.match(other.json.hookSpecificOutput.additionalContext, /show the user this connect link/);
  assert.equal(posts(), before);
});

test("first prompt of the install session: the request is created off the prompt path, the next prompt shows it", async () => {
  const ctx = setup();
  const r = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", "nothing to show yet: the prompt hook only reads connect.json");
  const cfile = path.join(ctx.data, "connect.json");
  assert.ok(await waitFor(() => fs.existsSync(cfile) && readJson(cfile).status === "pending", { timeoutMs: 10000 }));
  const next = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.match(next.json.systemMessage, /^Intent Check: connect your account → /);
  assert.match(next.json.hookSpecificOutput.additionalContext, /"done" or "skip"/);
});

test("a prompt that is a plugin command is not gated, and a skip reply carries on without the link", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  const cmd = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "/intent:status" }), ctx.env);
  assert.equal(cmd.stdout, "");
  const first = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "please build the pricing module" }), ctx.env);
  assert.match(first.json.hookSpecificOutput.additionalContext, /"done" or "skip"/);
  const skip = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "skip" }), ctx.env);
  assert.match(skip.json.hookSpecificOutput.additionalContext, /chose to skip/);
  const after = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "now add tests please" }), ctx.env);
  assert.equal(after.stdout, "", "no more connect talk this session");
});

test("a done reply before approval asks the user to approve; after approval the agent is told to carry on", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "please build the pricing module" }), ctx.env);
  const notYet = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "done" }), ctx.env);
  assert.match(notYet.json.hookSpecificOutput.additionalContext, /does not see it yet/);
  fp.state.connectApproved = true;
  const ok = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "done" }), ctx.env);
  assert.match(ok.json.hookSpecificOutput.additionalContext, /Intent Check connected as tester/);
  assert.match(ok.json.hookSpecificOutput.additionalContext, /Carry on with their original request/);
});

test("until connected nothing else is sent", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.equal(fp.jobRequests().length, n);
});

test("the background poller saves the key under the service URL (mode 600); the next prompt says connected as <handle>, once", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  fp.state.connectApproved = true;
  const cfg = path.join(ctx.data, "config.json");
  assert.ok(await waitFor(() => fs.existsSync(cfg) && (readJson(cfg).keys || {})[fp.url] === TEST_KEY, { timeoutMs: 10000 }));
  assert.equal(mode(cfg), 0o600);
  assert.equal(readJson(cfg).api_key, undefined, "new keys go under keys[api_url], not the legacy field");
  const r = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r.json.systemMessage, "Intent Check connected as tester");
  assert.match(r.json.hookSpecificOutput.additionalContext, /Intent Check connected as tester/);
  const r2 = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r2.stdout, "");
  // Now checks run.
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  const s = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(s.code, 2);
});

test("if the poller died, the next prompt picks the approval up itself", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  const cfile = path.join(ctx.data, "connect.json");
  const c = readJson(cfile);
  try { process.kill(c.poller_pid, "SIGKILL"); } catch { /* already gone */ }
  fs.writeFileSync(cfile, JSON.stringify({ ...c, poller_pid: 999999 }));
  fp.state.connectApproved = true;
  const r = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r.json.systemMessage, "Intent Check connected as tester");
  assert.equal(readJson(path.join(ctx.data, "config.json")).keys[fp.url], TEST_KEY);
});

test("INTENT_API_KEY skips the connect flow", async () => {
  const ctx = setup();
  const r = await runHook("session-start", fixture("session-start", ctx.repo), { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  assert.equal(r.stdout, "");
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
});
