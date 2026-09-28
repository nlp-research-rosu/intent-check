// Connect-link onboarding against the fake prover.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { fixture, tmpdir, makeRepo, baseEnv, runHook, waitFor } from "./helpers/env.js";
import { validateDef } from "./helpers/schema.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { connectApproved: false, connectKeyTaken: false, pollsBeforeDone: 0, scenario: "concerns" }));

function setup() {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), JSON.stringify({ consent_shown_at: "x" }));
  return { data, repo: makeRepo().dir, env: baseEnv(data, fp.url) };
}

const mode = (f) => fs.statSync(f).mode & 0o777;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("no key: one user-visible connect line per session, and the link for the agent", async () => {
  const ctx = setup();
  const n = fp.state.requests.length;
  const r = await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /^Intent Check: connect your account → http:\/\/127\.0\.0\.1:\d+\/connect\/KDRT-MWQX$/);
  assert.match(r.json.hookSpecificOutput.additionalContext, /connect at http:\/\/127\.0\.0\.1:\d+\/connect\/KDRT-MWQX/);
  const start = fp.state.requests.slice(n).find((x) => x.method === "POST" && x.path === "/v1/connect");
  assert.deepEqual(validateDef(start.body, "ConnectStart"), []);
  assert.equal(start.body.host, "claude-code");
  assert.equal(mode(path.join(ctx.data, "connect.json")), 0o600);

  const again = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(again.stdout, "", "shown once per session");

  // A new session shows the same pending link without a second connect request.
  const posts = fp.state.requests.filter((x) => x.path === "/v1/connect").length;
  const other = await runHook("prompt", fixture("prompt", ctx.repo, { session_id: "another-session" }), ctx.env);
  assert.match(other.json.systemMessage, /connect your account/);
  assert.equal(fp.state.requests.filter((x) => x.path === "/v1/connect").length, posts);
});

test("first prompt of the install session (no SessionStart) shows the link", async () => {
  const ctx = setup();
  const r = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.match(r.json.systemMessage, /^Intent Check: connect your account → /);
});

test("until connected nothing else is sent", async () => {
  const ctx = setup();
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def a(x):\n    y = x\n    return y\n");
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 0);
  assert.equal(fp.jobRequests().length, n);
});

test("the background poller saves the key (mode 600) and the next prompt says connected, once", async () => {
  const ctx = setup();
  await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
  fp.state.connectApproved = true;
  const cfg = path.join(ctx.data, "config.json");
  assert.ok(await waitFor(() => fs.existsSync(cfg) && readJson(cfg).api_key === TEST_KEY, { timeoutMs: 10000 }));
  assert.equal(mode(cfg), 0o600);
  const r = await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.equal(r.json.systemMessage, "Intent Check: connected.");
  assert.equal(r.json.hookSpecificOutput.additionalContext, "Intent Check: connected.");
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
  assert.equal(r.json.systemMessage, "Intent Check: connected.");
  assert.equal(readJson(path.join(ctx.data, "config.json")).api_key, TEST_KEY);
});

test("INTENT_API_KEY skips the connect flow", async () => {
  const ctx = setup();
  const r = await runHook("session-start", fixture("session-start", ctx.repo), { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  assert.equal(r.stdout, "");
  assert.equal(fs.existsSync(path.join(ctx.data, "connect.json")), false);
});
