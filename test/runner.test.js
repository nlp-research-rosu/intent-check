// The Stop runner end to end against a fake prover: submit, poll, .intent/, wake vs note, guards.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { fixture, tmpdir, makeRepo, baseEnv, runHook, readSessionFiles, saveKey, waitFor, sleep, BIN, ROOT } from "./helpers/env.js";
import { validateDef } from "./helpers/schema.js";

const PRICING = "# pricing.py\ndef apply_discount(price_cents: int, percent: int) -> int:\n    return price_cents - price_cents * percent // 100\n";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));

function setup({ key = true, git = true, env = {} } = {}) {
  const data = tmpdir("intent-data-");
  if (key) saveKey(data, TEST_KEY);
  const repo = makeRepo({ git });
  // Consent was shown in an earlier session, so outputs below are only what each test is about.
  fs.writeFileSync(path.join(data, "global.json"), JSON.stringify({ consent_shown_at: "2026-09-28T00:00:00Z" }));
  return { data, repo: repo.dir, gitc: repo.git, env: baseEnv(data, fp.url, env) };
}

// One agent turn: prompt, the agent writes files, Stop.
async function turn(ctx, files, { stopPatch = {}, prompt = "Add a helper that applies a percentage discount. It must never go below zero.", run = true } = {}) {
  await runHook("prompt", fixture("prompt", ctx.repo, { prompt }), ctx.env);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ctx.repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    await runHook("post-tool", fixture("post-tool-write", ctx.repo, { tool_input: { file_path: abs, content } }), ctx.env);
  }
  if (!run) return null;
  return runHook("stop", fixture("stop", ctx.repo, stopPatch), ctx.env);
}

const jobsSince = (n) => fp.jobRequests().slice(n);

test("concerns: submits a contract-valid job, writes .intent/ and wakes the agent (exit 2)", async () => {
  const ctx = setup();
  const n = fp.jobRequests().length;
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.split("\n")[0]), { rewakeSummary: "Intent Check: 1 concern in pricing.py" });
  assert.match(r.stderr, /^Intent Check: 1 concern about code changed in this session\. Report: http:\/\/127\.0\.0\.1:\d+\/r\/\w{22}\n/);
  assert.match(r.stderr, /Intent mismatch \(high\) at pricing\.py:3/);
  assert.match(r.stderr, /fix it directly, editing only pricing\.py/); // fixture permission_mode is acceptEdits

  const [req] = jobsSince(n);
  assert.deepEqual(validateDef(req, "JobRequest"), []);
  assert.equal(req.units[0].path, "pricing.py");
  assert.equal(req.units[0].sha256, "a949e6048d964c91f2a1587532adda76e4348d987f3c78cdf6c47f5b7b94a510");
  assert.match(req.units[0].diff, /^--- \/dev\/null\n\+\+\+ b\/pricing\.py/);
  assert.equal(req.intent.prompts.at(-1), "Add a helper that applies a percentage discount. It must never go below zero.");
  const post = fp.state.requests.filter((x) => x.method === "POST" && x.path === "/v1/jobs").at(-1);
  assert.equal(post.headers["x-intent-version"], JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version);
  assert.match(post.headers["idempotency-key"], /^[0-9a-f]{64}$/);
  assert.equal(post.headers.authorization, `Bearer ${TEST_KEY}`);

  const unit = path.join(ctx.repo, ".intent", "pricing.py");
  for (const f of ["INTENT.md", "SPEC.k", "SEMANTICS.k", "VERDICT.md", "meta.json"]) assert.ok(fs.existsSync(path.join(unit, f)), f);
  const log = fs.readFileSync(path.join(ctx.repo, ".intent", ".sent.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(log[0].paths, ["pricing.py"]);
  assert.ok(!JSON.stringify(log).includes("apply_discount"));
  assert.deepEqual(readSessionFiles(ctx.data)[0].pending, []);
});

test("no concerns: silent at Stop, one line at the next prompt", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "thanks" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /^Intent Check: no concerns · http:\/\/127\.0\.0\.1:\d+\/r\/\w{22}$/);
  assert.equal(next.json.systemMessage, undefined);
  const again = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "and again" }), ctx.env);
  assert.equal(again.stdout, "");
});

test("the Stop of a wake-up turn (stop_hook_active) never wakes; its result arrives as a note", async () => {
  const ctx = setup();
  const r = await turn(ctx, { "pricing.py": PRICING }, { stopPatch: { stop_hook_active: true } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /^Intent Check: 1 concern/);
});

test("a file fixed after a wake is re-checked but reported as a note, not another wake", async () => {
  const ctx = setup();
  assert.equal((await turn(ctx, { "pricing.py": PRICING })).code, 2);
  fp.state.concern = { id: "c2", type: "implementation_bug", severity: "high", path: "pricing.py", line: 2, claim_id: null, title: "Rounding is floor, not nearest", explanation: "x", fix_direction: "Round to nearest." };
  const r = await turn(ctx, { "pricing.py": PRICING.replace("// 100", "// 100  # fixed") });
  assert.equal(r.code, 0);
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /Rounding is floor/);
});

test("the same finding is not delivered twice within an hour", async () => {
  const ctx = setup();
  assert.equal((await turn(ctx, { "pricing.py": PRICING })).code, 2);
  const r = await turn(ctx, { "pricing.py": PRICING + "\n# touch\n# touch\n# touch\n" });
  assert.equal(r.code, 0);
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.equal(next.stdout, "");
});

test("fire cap: at most 3 wakes per session in 2 minutes, then notes", async () => {
  const ctx = setup();
  const codes = [];
  for (const name of ["a", "b", "c", "d"]) {
    fp.state.concern = null;
    codes.push((await turn(ctx, { [`${name}.py`]: `def ${name}(x):\n    y = x + 1\n    return y\n` })).code);
  }
  assert.deepEqual(codes, [2, 2, 2, 0]);
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /d\.py:3/);
});

test("default permission mode asks Fix or Skip", async () => {
  const ctx = setup();
  const r = await turn(ctx, { "pricing.py": PRICING }, { stopPatch: { permission_mode: "default" } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Fix or Skip \(use AskUserQuestion\)/);
});

test("headless (claude -p): detaches at once, never wakes, result becomes a note", async () => {
  const ctx = setup({ env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } });
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
  const note = await waitFor(() => (readSessionFiles(ctx.data)[0] || { notes: [] }).notes.length > 0);
  assert.ok(note);
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "VERDICT.md")));
});

test("spend cap (429): nothing during the turn, one user-visible line at the next prompt, once", async () => {
  fp.state.submitStatus = { status: 429, code: "spend_cap" };
  const ctx = setup();
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.match(next.json.systemMessage, /free check limit/);
  await turn(ctx, { "pricing.py": PRICING + "# more\n# more\n# more\n" });
  const again = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.equal(again.stdout, "");
});

test("a rejected saved key (401) is dropped, so the next prompt offers the connect link", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.data, "config.json"), JSON.stringify({ api_key: "ic_" + "Z".repeat(38) }));
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.data, "config.json"), "utf8")).api_key, undefined);
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.match(next.json.systemMessage, /^Intent Check: connect your account → http/);
});

test("prover unreachable: nothing shown, the turn's paths are kept for the next Stop", async () => {
  const ctx = setup({ env: { INTENT_API_URL: "http://127.0.0.1:9" } });
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  const [s] = readSessionFiles(ctx.data);
  assert.deepEqual(s.touched, [path.join(ctx.repo, "pricing.py")]);
});

for (const [name, env, off] of [["INTENT_DISABLED=1", { INTENT_DISABLED: "1" }, false], ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }, false], ["/intent:off", {}, true]]) {
  test(`${name} stops all uploads and all hook output`, async () => {
    const ctx = setup({ key: false, env });
    if (off) {
      const o = await runHook("off", undefined, ctx.env);
      assert.match(o.stdout, /Intent Check is off/);
    }
    // Connect pollers left running by other tests' data dirs are not ours; count everything else.
    const ours = () => fp.state.requests.filter((x) => !(x.method === "GET" && x.path.startsWith("/v1/connect/"))).length;
    const n = ours();
    const s = await runHook("session-start", fixture("session-start", ctx.repo), ctx.env);
    saveKey(ctx.data, TEST_KEY);
    if (off) {
      const c = JSON.parse(fs.readFileSync(path.join(ctx.data, "config.json"), "utf8"));
      fs.writeFileSync(path.join(ctx.data, "config.json"), JSON.stringify({ ...c, disabled: true }));
    }
    const r = await turn(ctx, { "pricing.py": PRICING });
    assert.equal(s.stdout + r.stdout + r.stderr, "");
    assert.equal(r.code, 0);
    assert.equal(ours(), n, "no request may leave the machine");
    assert.equal(fs.existsSync(path.join(ctx.repo, ".intent")), false);
    if (off) {
      const on = await runHook("on", undefined, ctx.env);
      assert.match(on.stdout, /Intent Check is on/);
      assert.equal((await turn(ctx, { "pricing.py": PRICING + "# on\n# on\n# on\n" })).code, 2);
    }
  });
}

test("SIGTERM (hook timeout or quit): a detached finisher keeps polling and writes .intent/", async () => {
  fp.state.pollsBeforeDone = 1000;
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING }, { run: false });
  const n = fp.state.requests.length;
  let child;
  const done = runHook("stop", fixture("stop", ctx.repo), ctx.env, { onSpawn: (c) => { child = c; } });
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/v1/jobs/"))));
  child.kill("SIGTERM");
  const r = await done;
  assert.equal(r.code, 0);
  fp.state.pollsBeforeDone = 0;
  assert.ok(await waitFor(() => fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "VERDICT.md")), { timeoutMs: 20000 }));
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "back" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /^Intent Check: 1 concern/);
});

test("late result: a job whose runner died is delivered at the next prompt (1 s check)", async () => {
  fp.state.pollsBeforeDone = 1000;
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING }, { run: false });
  const n = fp.state.requests.length;
  let child;
  const done = runHook("stop", fixture("stop", ctx.repo), ctx.env, { onSpawn: (c) => { child = c; } });
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/v1/jobs/"))));
  child.kill("SIGKILL");
  await done;
  fp.state.pollsBeforeDone = 0;
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "back" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /^Intent Check: 1 concern/);
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "meta.json")));
});

test("stale result: a file edited after submission gets the 'checked the version from' label", async () => {
  fp.state.pollsBeforeDone = 1;
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING }, { run: false });
  const n = fp.state.requests.length;
  const done = runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/v1/jobs/"))));
  fs.appendFileSync(path.join(ctx.repo, "pricing.py"), "# edited meanwhile\n");
  const r = await done;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Checked the version of pricing\.py from \d\d:\d\d; the file has changed since/);
});

test("a newer runner takes over the session's pending jobs; the old one exits quietly", async () => {
  fp.state.pollsBeforeDone = 1000;
  const ctx = setup();
  await turn(ctx, { "a.py": "def a(x):\n    y = x\n    return y\n" }, { run: false });
  const n = fp.state.requests.length;
  const first = runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/v1/jobs/"))));
  await turn(ctx, { "b.py": "def b(x):\n    y = x\n    return y\n" }, { run: false });
  const second = runHook("stop", fixture("stop", ctx.repo), ctx.env);
  const r1 = await first;
  assert.equal(r1.code, 0);
  assert.equal(r1.stderr, "");
  fp.state.pollsBeforeDone = 0;
  const r2 = await second;
  assert.equal(r2.code, 2);
  // If the wake came from one job while the other was still pending, a finisher settles the
  // other one; either way every job ends up settled and nobody keeps ownership.
  assert.ok(await waitFor(() => {
    const s = readSessionFiles(ctx.data)[0];
    return s.owner === null && s.pending.length === 0;
  }, { timeoutMs: 20000 }));
});

test("no git: diffs come from Claude Code's structuredPatch and the touched paths", async () => {
  const ctx = setup({ git: false });
  const abs = path.join(ctx.repo, "calc.py");
  fs.writeFileSync(abs, "def plus(a, b):\n    return a + b\n\ndef sub(a, b):\n    \"\"\"Return the difference of a and b.\"\"\"\n    return a - b\n");
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  const edit = fixture("post-tool-edit", ctx.repo);
  edit.tool_response.structuredPatch[0].lines.push("+    x = 1", "+    y = 2");
  await runHook("post-tool", edit, ctx.env);
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2);
  const [req] = jobsSince(n);
  assert.deepEqual(validateDef(req, "JobRequest"), []);
  assert.match(req.units[0].diff, /^--- a\/calc\.py\n\+\+\+ b\/calc\.py\n@@ -2,4 \+2,5 @@/);
  assert.equal(req.changed_lines, 3);
});

test("git: Bash-made edits count, pre-existing untracked and ignored files do not", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "old_untracked.py"), "def old():\n    a = 1\n    return a\n");
  fs.writeFileSync(path.join(ctx.repo, ".gitignore"), "secret_gen.py\n");
  ctx.gitc("add", ".gitignore");
  ctx.gitc("commit", "-qm", "ignore");
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  // Written by a shell command, so no PostToolUse event.
  fs.writeFileSync(path.join(ctx.repo, "via_bash.py"), "def v(x):\n    y = x * 2\n    return y\n");
  fs.writeFileSync(path.join(ctx.repo, "secret_gen.py"), "def s():\n    a = 1\n    return a\n");
  fs.writeFileSync(path.join(ctx.repo, "test_via_bash.py"), "def test_v():\n    assert v(1) == 2\n    assert True\n");
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2);
  assert.deepEqual(jobsSince(n)[0].units.map((u) => u.path), ["via_bash.py"]);
});

test("a Stop with fewer than 3 changed lines sends nothing", async () => {
  const ctx = setup();
  const n = fp.jobRequests().length;
  const r = await turn(ctx, { "tiny.py": "X = 1\n" });
  assert.equal(r.code, 0);
  assert.equal(fp.jobRequests().length, n);
});

test("old-Node shim: exits 0 silently when Node is older than 18", async () => {
  const pre = path.join(tmpdir(), "old-node.cjs");
  fs.writeFileSync(pre, "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '16.20.0' } });\n");
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["--require", pre, BIN, "stop"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
    c.stdin.end("{}");
  });
  assert.deepEqual(r, { code: 0, out: "" });
  const first = fs.readFileSync(BIN, "utf8").split("\n")[0];
  assert.doesNotMatch(first, /\?\.|\?\?|=>|\bconst\b|\blet\b|`/);
});

void sleep;
