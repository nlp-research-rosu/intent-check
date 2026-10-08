// Per-edit mode on Codex (apply_patch, one child per path) and shell-written files (Bash scan),
// plus the one-time hook notice. Payloads replayed through bin/intent.js --host codex.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, tmpdir, makeRepo, baseEnv, saveKey, waitFor, sleep, readSessionFiles, ROOT, BIN } from "./helpers/env.js";

const FX = path.join(ROOT, "test", "fixtures", "codex");
const CODE = (n) => Array.from({ length: 6 }, (_, i) => `def f${n}_${i}(x):\n    return x * ${i + 2}\n`).join("\n");

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));

function cfx(name, dir, transcript, patch = {}) {
  const raw = fs.readFileSync(path.join(FX, `${name}.json`), "utf8").split("/work/proj").join(dir);
  return { ...JSON.parse(raw), session_id: "01a0e925-b8c6-7ff3-ad68-a52ef7638565", transcript_path: transcript, ...patch };
}

function rollout(dir) {
  const f = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ type: "session_meta", payload: { session_id: "s", originator: "codex-tui", cli_version: "0.158.0" } }),
    JSON.stringify({ type: "turn_context", payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, collaboration_mode: { mode: "default" } } }),
  ].join("\n") + "\n");
  return f;
}

function run(event, payload, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [BIN, event, "--host", "codex"], { env, cwd: payload.cwd });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => { stdout += d; });
    c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0, json: stdout ? JSON.parse(stdout.split("\n")[0]) : null }));
    c.stdin.end(JSON.stringify(payload));
  });
}

function setup({ mode = "per-edit", git = true, notice = false } = {}) {
  const data = tmpdir("intent-pec-data-");
  saveKey(data, TEST_KEY);
  fs.writeFileSync(path.join(data, "global.json"), notice ? JSON.stringify({ consent_shown_at: "2026-09-28T00:00:00Z" }) : QUIET_GLOBAL);
  const repo = makeRepo({ git }).dir;
  const env = baseEnv(data, fp.url, { INTENT_MODE: mode, PLUGIN_ROOT: ROOT, PLUGIN_DATA: data });
  return { data, repo, env, transcript: rollout(tmpdir("intent-pec-home-")) };
}

const prompt = (ctx) => run("prompt", cfx("prompt", ctx.repo, ctx.transcript, { prompt: "Add helpers; results must never be negative." }), ctx.env);
const patchOf = (files) => "*** Begin Patch\n" + Object.entries(files).map(([rel, c]) => `*** Add File: ${rel}\n` + c.split("\n").filter(Boolean).map((l) => `+${l}`).join("\n")).join("\n") + "\n*** End Patch";
async function applyPatch(ctx, files, id = "exec-1") {
  for (const [rel, c] of Object.entries(files)) fs.writeFileSync(path.join(ctx.repo, rel), c);
  return run("post-tool", cfx("post-tool-apply-patch", ctx.repo, ctx.transcript, { tool_input: { command: patchOf(files) }, tool_use_id: id }), ctx.env);
}
const bash = (ctx, id = "exec-b1") => run("post-tool", cfx("post-tool-bash", ctx.repo, ctx.transcript, { tool_use_id: id }), ctx.env);
const jobsBefore = () => fp.jobRequests().length;
const edits = (ctx) => Object.values(readSessionFiles(ctx.data)[0].edit_jobs || {});

test("codex apply_patch in per-edit mode: one edit job per path, host codex with codex_modes", async () => {
  const ctx = setup();
  await prompt(ctx);
  const n = jobsBefore();
  const r = await applyPatch(ctx, { "a.py": CODE(1), "b.py": CODE(2) });
  assert.equal(r.code, 0);
  assert.ok(await waitFor(() => fp.jobRequests().length >= n + 2), "two jobs");
  const reqs = fp.jobRequests().slice(n);
  assert.deepEqual(reqs.map((q) => q.units[0].path).sort(), ["a.py", "b.py"]);
  for (const q of reqs) {
    assert.equal(q.mode, "edit");
    assert.equal(q.per_edit, true);
    assert.equal(q.host, "codex");
    assert.equal(q.codex_modes.approval_policy, "on-request");
    assert.equal(q.permission_mode, null);
  }
  for (const p of fp.state.requests.filter((x) => x.path === "/v1/jobs" && x.method === "POST")) assert.equal(p.headers["x-intent-supersede"], undefined);
});

test("codex apply_patch in classic mode: nothing at the edit", async () => {
  const ctx = setup({ mode: "classic" });
  await prompt(ctx);
  const n = jobsBefore();
  const r = await applyPatch(ctx, { "a.py": CODE(1) });
  assert.equal(r.code, 0);
  await sleep(800);
  assert.equal(jobsBefore(), n);
});

test("codex: a concern from an earlier edit arrives as PostToolUse context on the next edit", async () => {
  const ctx = setup();
  await prompt(ctx);
  await applyPatch(ctx, { "a.py": CODE(1) }, "exec-1");
  assert.ok(await waitFor(() => (readSessionFiles(ctx.data)[0]?.notes || []).some((x) => x.kind === "concerns")), "concern note");
  const r = await applyPatch(ctx, { "c.py": CODE(3) }, "exec-2");
  assert.match(r.stdout, /Intent mismatch/);
  assert.match(r.stdout, /PostToolUse/);
});

test("codex Stop does not resubmit a covered file and carries the in-flight concern as exit 2", async () => {
  fp.state.pollsBeforeDone = 1;
  const ctx = setup();
  await prompt(ctx);
  await applyPatch(ctx, { "a.py": CODE(1) });
  assert.ok(await waitFor(() => edits(ctx).length === 1), "job recorded");
  const n = jobsBefore();
  const r = await run("stop", cfx("stop", ctx.repo, ctx.transcript), ctx.env);
  assert.equal(jobsBefore(), n, JSON.stringify([fp.jobRequests().slice(n).map((q) => [q.mode, q.units.map((u) => u.path + u.sha256.slice(0,6))]), edits(ctx).map((e) => [e.rel, e.sha256.slice(0,6), e.settled])]));
  assert.ok(r.code === 0 || r.code === 2, r.stderr);
  if (r.code === 2) assert.match(r.stderr, /Intent mismatch/);
});

test("bash-written new file: the scan spawns one edit job for it", async () => {
  const ctx = setup();
  await prompt(ctx);
  const n = jobsBefore();
  fs.writeFileSync(path.join(ctx.repo, "shell.py"), CODE(7));
  const r = await bash(ctx);
  assert.equal(r.code, 0);
  assert.ok(r.ms < 600, String(r.ms));
  assert.ok(await waitFor(() => fp.jobRequests().length >= n + 1), "job");
  const q = fp.jobRequests()[n];
  assert.equal(q.mode, "edit");
  assert.equal(q.units[0].path, "shell.py");
  assert.equal(q.host, "codex");
});

test("bash scan: an unchanged sha is not checked twice", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await prompt(ctx);
  fs.writeFileSync(path.join(ctx.repo, "shell.py"), CODE(7));
  await bash(ctx, "exec-b1");
  assert.ok(await waitFor(() => edits(ctx).some((e) => e.settled)), "settled");
  const n = jobsBefore();
  await bash(ctx, "exec-b2");
  await sleep(1000);
  assert.equal(jobsBefore(), n);
  // A changed file is checked again.
  fs.writeFileSync(path.join(ctx.repo, "shell.py"), CODE(8));
  await bash(ctx, "exec-b3");
  assert.ok(await waitFor(() => fp.jobRequests().length >= n + 1), "new content checked");
});

test("bash scan: a file already covered by an apply_patch check is not rechecked", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  await prompt(ctx);
  await applyPatch(ctx, { "a.py": CODE(1) });
  assert.ok(await waitFor(() => edits(ctx).some((e) => e.settled)), "settled");
  const n = jobsBefore();
  await bash(ctx);
  await sleep(1000);
  assert.equal(jobsBefore(), n, JSON.stringify([fp.jobRequests().slice(n).map((q) => [q.mode, q.units.map((u) => u.path + u.sha256.slice(0,6))]), edits(ctx).map((e) => [e.rel, e.sha256.slice(0,6), e.settled])]));
});

test("bash scan: the in-flight cap holds", async () => {
  fp.state.scenario = "no_concerns";
  fp.state.pollsBeforeDone = 50;
  const ctx = setup();
  await prompt(ctx);
  for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(ctx.repo, `s${i}.py`), CODE(i));
  const n = jobsBefore();
  await bash(ctx);
  assert.ok(await waitFor(() => fp.jobRequests().length >= n + 1), "some jobs");
  await sleep(2500);
  assert.ok(fp.jobRequests().length - n <= 12, String(fp.jobRequests().length - n));
});

test("bash hook: classic mode returns at once and spawns nothing", async () => {
  const ctx = setup({ mode: "classic" });
  await prompt(ctx);
  const n = jobsBefore();
  fs.writeFileSync(path.join(ctx.repo, "shell.py"), CODE(7));
  const r = await bash(ctx);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  await sleep(800);
  assert.equal(jobsBefore(), n);
});

test("bash hook: outside git there is no baseline and no job", async () => {
  const ctx = setup({ git: false });
  await prompt(ctx);
  const n = jobsBefore();
  fs.writeFileSync(path.join(ctx.repo, "shell.py"), CODE(7));
  const r = await bash(ctx);
  assert.equal(r.code, 0);
  await sleep(800);
  assert.equal(jobsBefore(), n);
});

test("codex hook notice shows once per version, never on Claude Code", async () => {
  const ctx = setup({ notice: true });
  const ss = () => run("session-start", cfx("session-start", ctx.repo, ctx.transcript), ctx.env);
  const first = await ss();
  assert.match(first.stdout, /approve it in \/hooks/);
  const again = await ss();
  assert.doesNotMatch(again.stdout, /approve it in \/hooks/);
  const g = JSON.parse(fs.readFileSync(path.join(ctx.data, "global.json"), "utf8"));
  assert.match(g.hook_notice_version, /^\d+\.\d+\.\d+/);

  const cc = setup({ notice: true });
  const env = { ...cc.env };
  delete env.PLUGIN_ROOT; delete env.PLUGIN_DATA;
  const { runHook, fixture } = await import("./helpers/env.js");
  const r = await runHook("session-start", fixture("session-start", cc.repo), env);
  assert.doesNotMatch(r.stdout, /approve it in \/hooks/);
});
