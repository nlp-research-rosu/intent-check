// M5: the plugin on Codex. Replays the captured Codex payloads through bin/intent.js --host codex.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { tmpdir, makeRepo, baseEnv, saveKey, waitFor, ROOT, BIN } from "./helpers/env.js";
import { spawn } from "node:child_process";
import { validateDef } from "./helpers/schema.js";
import { applyPatchPaths, readTurnContext, codexModes, fixModeFor } from "../lib/codex.js";
import { hostVersion } from "../lib/config.js";

const FX = path.join(ROOT, "test", "fixtures", "codex");
const PRICING = "# pricing.py\ndef apply_discount(price_cents: int, percent: int) -> int:\n    return price_cents - price_cents * percent // 100\n";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));

function cfx(name, dir, transcript, patch = {}) {
  const raw = fs.readFileSync(path.join(FX, `${name}.json`), "utf8").split("/work/proj").join(dir);
  const o = { ...JSON.parse(raw), ...patch };
  if (transcript) o.transcript_path = transcript;
  return o;
}

function rollout(dir, { approval = "on-request", sandbox = "workspace-write", mode = "default" } = {}) {
  const f = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ type: "session_meta", payload: { session_id: "s", originator: "codex-tui", cli_version: "0.158.0" } }),
    JSON.stringify({ type: "turn_context", payload: { approval_policy: approval, sandbox_policy: { type: sandbox }, collaboration_mode: { mode } } }),
  ].join("\n") + "\n");
  return f;
}

// Run like Codex: shell form, PLUGIN_ROOT/PLUGIN_DATA set, and (under Claude Code) leaked CLAUDECODE.
function run(event, payload, env, { hostFlag = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [BIN, event, ...(hostFlag ? ["--host", "codex"] : [])];
    const c = spawn(process.execPath, args, { env, cwd: payload.cwd });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0, json: stdout ? JSON.parse(stdout.split("\n")[0]) : null }));
    c.stdin.end(JSON.stringify(payload));
  });
}

function setup({ key = true } = {}) {
  const data = tmpdir("intent-codex-data-");
  if (key) saveKey(data, TEST_KEY);
  fs.writeFileSync(path.join(data, "global.json"), JSON.stringify({ consent_shown_at: "x" }));
  const { dir, git } = makeRepo();
  const env = baseEnv(data, fp.url, { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1", PLUGIN_ROOT: ROOT, PLUGIN_DATA: data });
  return { data, repo: dir, git, env, transcript: rollout(tmpdir("intent-codex-home-")) };
}

async function turn(ctx, files, stopPatch = {}) {
  await run("prompt", cfx("prompt", ctx.repo, ctx.transcript, { prompt: "Add apply_discount; never below zero." }), ctx.env);
  let patch = "*** Begin Patch\n";
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(ctx.repo, rel), content);
    patch += `*** Add File: ${rel}\n` + content.split("\n").filter(Boolean).map((l) => `+${l}`).join("\n") + "\n";
  }
  patch += "*** End Patch";
  await run("post-tool", cfx("post-tool-apply-patch", ctx.repo, ctx.transcript, { tool_input: { command: patch } }), ctx.env);
  return run("stop", cfx("stop", ctx.repo, ctx.transcript, stopPatch), ctx.env);
}

test("apply_patch paths: add, update and move targets, relative or absolute; not deleted or moved-from", () => {
  const p = JSON.parse(fs.readFileSync(path.join(FX, "post-tool-apply-patch.json"), "utf8"));
  assert.deepEqual(applyPatchPaths(p.tool_input.command, "/work/proj"), ["/work/proj/calc.py", "/work/proj/util.py", "/work/proj/new_name.py"]);
  assert.deepEqual(applyPatchPaths(undefined, "/x"), []);
});

test("modes come from the transcript's latest turn_context; fix directly only without approvals", () => {
  const tc = readTurnContext(path.join(FX, "rollout.jsonl"));
  assert.deepEqual(codexModes(tc), { approval_policy: "on-request", sandbox: "workspace-write", collaboration_mode: "default" });
  assert.equal(fixModeFor(codexModes(tc)), "default");
  assert.equal(fixModeFor({ approval_policy: "never", sandbox: "workspace-write", collaboration_mode: "default" }), "bypassPermissions");
  assert.equal(fixModeFor({ approval_policy: "never", sandbox: "read-only", collaboration_mode: "default" }), "default");
  assert.equal(fixModeFor({ approval_policy: "never", sandbox: "danger-full-access", collaboration_mode: "plan" }), "default");
  assert.equal(fixModeFor(codexModes(null)), "default");
  assert.equal(hostVersion(path.join(FX, "rollout.jsonl")), "0.147.0");
});

test("Stop is sync and quick: submits a codex job, hands polling to a detached process, exits 0", async () => {
  fp.state.pollsBeforeDone = 1; // still queued when Stop looks, so the detached poller settles it
  const ctx = setup();
  const n = fp.jobRequests().length;
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, "");
  assert.ok(r.ms < 3000, `stop took ${r.ms} ms`);
  const [req] = fp.jobRequests().slice(n);
  assert.deepEqual(validateDef(req, "JobRequest"), []);
  assert.equal(req.host, "codex");
  assert.equal(req.host_version, "0.158.0");
  assert.equal(req.permission_mode, null);
  assert.deepEqual(req.codex_modes, { approval_policy: "on-request", sandbox: "workspace-write", collaboration_mode: "default" });
  assert.deepEqual(req.units.map((u) => u.path), ["pricing.py"]);
  assert.ok(await waitFor(() => fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "VERDICT.md"))));
  // Concerns reach the agent with the next prompt, as additionalContext only.
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(ctx.data, "sessions", fs.readdirSync(path.join(ctx.data, "sessions")).find((f) => f.endsWith(".json"))), "utf8")).notes.length > 0);
  const next = await run("prompt", cfx("prompt", ctx.repo, ctx.transcript, { prompt: "next" }), ctx.env);
  assert.equal(next.json.systemMessage, undefined);
  assert.equal(next.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const text = next.json.hookSpecificOutput.additionalContext;
  assert.match(text, /^Intent Check: 1 concern/);
  assert.match(text, /Fix or Skip as a plain question/);
  assert.doesNotMatch(text, /AskUserQuestion/);
});

test("a result that is already done when Stop checks is handed over in the same turn", async () => {
  const ctx = setup();
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^Intent Check: 1 concern/);
});

test("no concerns stay silent on Codex", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING });
  assert.ok(await waitFor(() => fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "meta.json"))));
  await new Promise((r) => setTimeout(r, 300));
  const next = await run("prompt", cfx("prompt", ctx.repo, ctx.transcript, { prompt: "next" }), ctx.env);
  assert.equal(next.stdout, "");
});

test("finished concerns waiting at Stop are handed over with exit 2, but not at the end of that continuation", async () => {
  fp.state.pollsBeforeDone = 1;
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING });
  assert.ok(await waitFor(() => fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "VERDICT.md"))));
  await new Promise((r) => setTimeout(r, 300));
  const r = await run("stop", cfx("stop", ctx.repo, ctx.transcript), ctx.env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^Intent Check: 1 concern/);
  const again = await run("stop", cfx("stop-active", ctx.repo, ctx.transcript), ctx.env);
  assert.equal(again.code, 0);
});

test("fix directly when Codex runs without approvals", async () => {
  fp.state.pollsBeforeDone = 1;
  const ctx = setup();
  ctx.transcript = rollout(tmpdir("intent-codex-home-"), { approval: "never" });
  await turn(ctx, { "pricing.py": PRICING });
  assert.ok(await waitFor(() => fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "VERDICT.md"))));
  await new Promise((r) => setTimeout(r, 300));
  const next = await run("prompt", cfx("prompt", ctx.repo, ctx.transcript, { prompt: "next" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /fix it directly, editing only pricing\.py/);
});

test("not connected: the connect link arrives as context (Codex shows it), host codex; PLUGIN_ROOT alone selects Codex", async () => {
  const ctx = setup({ key: false });
  const n = fp.state.requests.length;
  const r = await run("prompt", cfx("prompt", ctx.repo, ctx.transcript), ctx.env, { hostFlag: false });
  assert.equal(r.json.systemMessage, undefined);
  assert.match(r.json.hookSpecificOutput.additionalContext, /^Intent Check: connect your account → http/);
  const start = fp.state.requests.slice(n).find((x) => x.path === "/v1/connect");
  assert.equal(start.body.host, "codex");
});

test("the data dir is created on first use (Codex does not create it)", async () => {
  const ctx = setup();
  const fresh = path.join(tmpdir("intent-codex-"), "plugins", "data", "intent-intentcomputing");
  const env = { ...ctx.env, CLAUDE_PLUGIN_DATA: fresh, PLUGIN_DATA: fresh, INTENT_API_KEY: TEST_KEY };
  const r = await run("prompt", cfx("prompt", ctx.repo, ctx.transcript), env);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(fresh, "sessions")));
});

test("e2e trust helper reproduces hashes Codex itself stored in the spike", async () => {
  const { hookHash, trustEntries } = await import("./e2e/codex-trust.mjs");
  assert.equal(hookHash("session_start", null, { command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hook.js" SessionStart' }),
    "sha256:dc66c596ab3416fb031e39bf104ff6fdb3f40b1a8904307cea82b6f27f3c4965");
  assert.equal(hookHash("post_tool_use", "^(apply_patch|Edit|Write|Bash)$", { command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/hook.js" PostToolUse', async: true }),
    "sha256:9cc2d922f75b2e4650d9b905f43f189e04fbdce7c46daa651f05e60a54660d03");
  assert.match(trustEntries(), /\[hooks\.state\."intent@intentcomputing:hooks\/codex-hooks\.json:stop:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"/);
});

test("C1: a slow service never holds the Codex Stop near its limit and queued reviews are kept", async () => {
  const http = await import("node:http");
  const sockets = [];
  const hang = http.createServer(() => { /* never answers */ });
  hang.on("connection", (s) => sockets.push(s));
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const ctx = setup();
  const env = { ...ctx.env, INTENT_API_URL: `http://127.0.0.1:${hang.address().port}` };
  // A queued review plus an edit: two submits would be 16 s at 8 s each.
  fs.writeFileSync(path.join(ctx.repo, "queued.py"), "Q = 1\n");
  const { enqueue } = await import("../lib/queue.js");
  enqueue(ctx.repo, "request", ["queued.py"]);
  await run("prompt", cfx("prompt", ctx.repo, ctx.transcript), env);
  fs.writeFileSync(path.join(ctx.repo, "edited.py"), "def e(x):\n    y = x\n    return y\n");
  const r = await run("stop", cfx("stop", ctx.repo, ctx.transcript), env);
  for (const s of sockets) s.destroy();
  hang.close();
  assert.equal(r.code, 0);
  assert.ok(r.ms < 12000, `stop took ${r.ms} ms`);
  assert.equal(fs.readdirSync(path.join(ctx.repo, ".intent", ".queue")).length, 1, "queued review kept");
});

test("Codex consent notice points at the ways Codex can turn it off", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.data, "global.json"), "{}");
  const r = await run("session-start", cfx("session-start", ctx.repo, ctx.transcript), { ...ctx.env, INTENT_API_KEY: TEST_KEY });
  const text = r.json.hookSpecificOutput.additionalContext;
  assert.match(text, /INTENT_DISABLED=1/);
  assert.doesNotMatch(text, /\/intent:off/);
});

test("r2-4: Codex Stop while off drops queued reviews", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "q.py"), "Q = 1\n");
  const { enqueue } = await import("../lib/queue.js");
  enqueue(ctx.repo, "request", ["q.py"]);
  const n = fp.jobRequests().length;
  const r = await run("stop", cfx("stop", ctx.repo, ctx.transcript), { ...ctx.env, INTENT_DISABLED: "1" });
  assert.equal(r.code, 0);
  assert.deepEqual(fs.readdirSync(path.join(ctx.repo, ".intent", ".queue")), []);
  assert.equal(fp.jobRequests().length, n);
});

test("r2-5: every job of a Codex Stop gets its result, even when the first settles at once", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "q.py"), "Q = 1\n");
  const { enqueue } = await import("../lib/queue.js");
  enqueue(ctx.repo, "request", ["q.py"]);
  await turn(ctx, { "pricing.py": PRICING });
  for (const f of ["pricing.py", "q.py"]) {
    assert.ok(await waitFor(() => fs.existsSync(path.join(ctx.repo, ".intent", f, "meta.json")), { timeoutMs: 15000 }), f);
  }
});

test("r2-1: a slow submit that the server did create is replayed at the next Stop, not duplicated", async () => {
  fp.state.scenario = "no_concerns";
  fp.state.submitDelayMs = 9000; // longer than the Codex submit timeout (8 s)
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "q.py"), "Q = 1\n");
  const { enqueue } = await import("../lib/queue.js");
  enqueue(ctx.repo, "request", ["q.py"]);
  const jobsBefore = fp.state.jobs.size;
  await run("stop", cfx("stop", ctx.repo, ctx.transcript), ctx.env);
  assert.equal(fs.readdirSync(path.join(ctx.repo, ".intent", ".queue")).length, 1, "put back after the timeout");
  fp.state.submitDelayMs = 0;
  await run("stop", cfx("stop", ctx.repo, ctx.transcript), ctx.env);
  assert.equal(fp.state.jobs.size - jobsBefore, 1, "one server job for both attempts");
  assert.ok(await waitFor(() => fs.existsSync(path.join(ctx.repo, ".intent", "q.py", "meta.json")), { timeoutMs: 15000 }));
});
