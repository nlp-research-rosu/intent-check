// Connect-link onboarding against the fake prover.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "../lib/fsutil.js";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, assertOwnerOnly, fixture, tmpdir, makeRepo, baseEnv, runHook, waitFor, savedKey, credentialsPath } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { connectApproved: false, connectKeyTaken: false, connectStatus: null, connectStartStatus: null, keyRevoked: false, key: TEST_KEY, handle: "tester", pollsBeforeDone: 0, scenario: "concerns" }));

function setup() {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  return { data, repo: makeRepo().dir, env: baseEnv(data, fp.url) };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const posts = () => fp.state.requests.filter((x) => x.method === "POST" && x.path === "/api/cli-connect" && x.body && x.body.action === "start").length;
const LINK = /http:\/\/127\.0\.0\.1:\d+\/connect\/KDRT-MWQX/;

test("no key: SessionStart creates the request and shows the link; the prompt tells the agent to wait for done or skip", async () => {
  const ctx = setup();
  const n = fp.state.requests.length;
  const r = await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /^Intent Check: connect your account → http:\/\/127\.0\.0\.1:\d+\/connect\/KDRT-MWQX$/);
  const start = fp.state.requests.slice(n).find((x) => x.method === "POST" && x.path === "/api/cli-connect");
  assert.deepEqual(start.body, { action: "start" });
  const cfile = path.join(ctx.data, "connect.json");
  assertOwnerOnly(cfile);
  const c = readJson(cfile);
  assert.equal(c.api_url, fp.url, "connect.json records the service");
  assert.ok(c.poller_pid > 0, "the pid of the running intent-check login");
  assert.equal(c.user_code, "KDRT-MWQX");
  assert.equal(c.device_code, undefined, "the device code stays with the CLI");

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
  const cmd = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "/intent:off" }), ctx.env);
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
  // The usual order: the login process saves the key before the user replies "done"; the
  // gated agent must still be told to carry on.
  assert.ok(await waitFor(() => savedKey(ctx.data, fp.url) === TEST_KEY, { timeoutMs: 10000 }));
  const ok = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "done" }), ctx.env);
  assert.match(ok.json.hookSpecificOutput.additionalContext, /Intent Check connected/);
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

test("the login process saves the key in the credentials file (file 600, folder 700); the next prompt says connected, once", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  fp.state.connectApproved = true;
  assert.ok(await waitFor(() => savedKey(ctx.data, fp.url) === TEST_KEY, { timeoutMs: 10000 }));
  assertOwnerOnly(credentialsPath(ctx.data));
  assertOwnerOnly(path.dirname(credentialsPath(ctx.data)), 0o700);
  const r = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r.json.systemMessage, "Intent Check connected");
  assert.match(r.json.hookSpecificOutput.additionalContext, /Intent Check connected/);
  const r2 = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r2.stdout, "");
  // Now checks run.
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  const s = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(s.code, 2);
});

test("if the login process died, the next prompt starts a new one and the one after shows it with the reason", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  const cfile = path.join(ctx.data, "connect.json");
  const c = readJson(cfile);
  process.kill(c.poller_pid, "SIGKILL");
  assert.ok(await waitFor(() => !isPidAlive(c.poller_pid), { timeoutMs: 5000 }));
  const quiet = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(quiet.stdout, "");
  assert.ok(await waitFor(() => readJson(cfile).created_at !== c.created_at && readJson(cfile).status === "pending", { timeoutMs: 10000 }));
  const r = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "next request that is long enough" }), ctx.env);
  assert.match(r.json.systemMessage, /sign-in stopped before it finished/i);
  assert.match(r.json.systemMessage, /connect your account → /);
});

test("INTENT_API_KEY skips the connect flow", async () => {
  const ctx = setup();
  const r = await runHook("session-start", fixture("session-start", ctx.repo), { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  assert.equal(r.stdout, "");
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
});
