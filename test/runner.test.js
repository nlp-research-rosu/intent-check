// The Stop runner end to end against a fake prover: submit, poll, .intent/, wake vs note, guards.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, fixture, tmpdir, makeRepo, baseEnv, runHook, readSessionFiles, saveKey, waitFor, sleep, BIN, ROOT } from "./helpers/env.js";
import { validateDef } from "./helpers/schema.js";

const PRICING = "# pricing.py\ndef apply_discount(price_cents: int, percent: int) -> int:\n    return price_cents - price_cents * percent // 100\n";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));

function setup({ key = true, git = true, env = {} } = {}) {
  const data = tmpdir("intent-data-");
  if (key) saveKey(data, TEST_KEY, fp.url);
  const repo = makeRepo({ git });
  // Consent was shown in an earlier session, so outputs below are only what each test is about.
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
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
  assert.match(r.stderr, /^Intent Check: 1 concern about code changed in this session\. Report: http:\/\/127\.0\.0\.1:\d+\/tasks\/[0-9a-f-]{36}\n/);
  assert.match(r.stderr, /Intent mismatch \(high\) at pricing\.py:3/);
  assert.match(r.stderr, /fix it directly, editing only pricing\.py/); // fixture permission_mode is acceptEdits

  const [req] = jobsSince(n);
  assert.deepEqual(validateDef(req, "JobRequest"), []);
  assert.equal(req.units[0].path, "pricing.py");
  assert.equal(req.units[0].sha256, "a949e6048d964c91f2a1587532adda76e4348d987f3c78cdf6c47f5b7b94a510");
  assert.match(req.units[0].diff, /^--- \/dev\/null\n\+\+\+ b\/pricing\.py/);
  assert.equal(req.intent.prompts.at(-1), "Add a helper that applies a percentage discount. It must never go below zero.");
  const post = fp.state.requests.filter((x) => x.method === "POST" && x.path === "/intent-checks").at(-1);
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

test("a job carries intent.notes from the repo's .intent/NOTES.md", async () => {
  const ctx = setup();
  fs.mkdirSync(path.join(ctx.repo, ".intent"), { recursive: true });
  fs.writeFileSync(path.join(ctx.repo, ".intent", "NOTES.md"), "- Coupons intentionally never expire; the docstring is stale.\n");
  const n = fp.jobRequests().length;
  await turn(ctx, { "pricing.py": PRICING });
  const [req] = jobsSince(n);
  assert.deepEqual(validateDef(req, "JobRequest"), []);
  assert.match(req.intent.notes, /Coupons intentionally never expire/);
});

test("no concerns: silent at Stop; the model and the user each get a line at the next prompt", async () => {
  fp.state.scenario = "no_concerns";
  const ctx = setup();
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "thanks" }), ctx.env);
  assert.match(next.json.hookSpecificOutput.additionalContext, /^Intent Check: no concerns in pricing\.py · http:\/\/127\.0\.0\.1:\d+\/tasks\/[0-9a-f-]{36}$/);
  assert.match(next.json.systemMessage, /^Intent Check: checked `pricing\.py` · no concerns · http:\/\/127\.0\.0\.1:\d+\/tasks\/[0-9a-f-]{36}$/);
  const again = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "and again" }), ctx.env);
  assert.equal(again.stdout, "");
});

test("failed job: one user note, /intent:doctor shows the error, last check not ok", async () => {
  fp.state.scenario = "failed";
  const ctx = setup();
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.ok(await waitFor(() => (readSessionFiles(ctx.data)[0] || { notes: [] }).notes.length > 0));
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "thanks" }), ctx.env);
  assert.match(next.json.systemMessage, /^Intent Check could not finish checking `pricing\.py`, so there is no report for it\. Run \/intent:deepscan with the files to try again\. · http:\/\/127\.0\.0\.1:\d+\/tasks\/[0-9a-f-]{36}$/);
  assert.doesNotMatch(next.json.systemMessage, /[\u2013\u2014]/);
  const again = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "and again" }), ctx.env);
  assert.equal(again.stdout, "");
  const g = JSON.parse(fs.readFileSync(path.join(ctx.data, "global.json"), "utf8"));
  assert.equal(g.last_check.ok, false);
  assert.match(g.last_error.text, /^check failed on the service \(CHECK_FAILED\), job \S+$/);
});

test("a queued check the daily cap caught ends failed with SPEND_CAP: the spend note, not a failure note", async () => {
  fp.state.scenario = "failed";
  fp.state.failCode = "SPEND_CAP";
  try {
    const ctx = setup();
    await turn(ctx, { "pricing.py": PRICING });
    assert.ok(await waitFor(() => (readSessionFiles(ctx.data)[0] || { notes: [] }).notes.length > 0));
    const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "thanks" }), ctx.env);
    assert.match(next.json.systemMessage, /today's free check limit was reached/);
  } finally { fp.state.failCode = null; }
});

test("failed job: Codex shows the note too (it drops only quiet notes)", async () => {
  fp.state.scenario = "failed";
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING });
  assert.ok(await waitFor(() => (readSessionFiles(ctx.data)[0] || { notes: [] }).notes.length > 0));
  const { drainNotes } = await import("../lib/runner.js");
  const keep = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = ctx.data;
  try {
    const key = path.basename(fs.readdirSync(path.join(ctx.data, "sessions"))[0], ".json");
    const out = drainNotes(key, { host: "codex" });
    assert.match(out.user, /^Intent Check could not finish checking `pricing\.py`/);
  } finally {
    if (keep === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = keep;
  }
});

test("superseded job: no note and no recorded error", async () => {
  fp.state.scenario = "superseded";
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING });
  await sleep(1500);
  assert.deepEqual((readSessionFiles(ctx.data)[0] || { notes: [] }).notes, []);
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "thanks" }), ctx.env);
  assert.doesNotMatch(next.stdout, /could not finish/);
  const g = JSON.parse(fs.readFileSync(path.join(ctx.data, "global.json"), "utf8"));
  assert.equal(g.last_check.ok, true);
  assert.equal(g.last_error, undefined);
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
  fp.state.concern = { id: "c2", type: "implementationBug", severity: "high", path: "pricing.py", line: 2, claimId: null, title: "Rounding is floor, not nearest", explanation: "x", fixDirection: "Round to nearest." };
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
  assert.match(r.stderr, /Fix, Skip or Intended \(use AskUserQuestion\)/);
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

test("entrypoint matrix: only the SDKs/local-agent/mcp detach; everything else (including unset) wakes", async () => {
  for (const entrypoint of ["cli", "claude-vscode", "claude-desktop", ""]) {
    const ctx = setup({ env: { CLAUDE_CODE_ENTRYPOINT: entrypoint } });
    const r = await turn(ctx, { "pricing.py": PRICING });
    assert.equal(r.code, 2, `entrypoint ${JSON.stringify(entrypoint)} should wake`);
  }
  for (const entrypoint of ["sdk-cli", "sdk-ts", "sdk-py", "local-agent", "mcp"]) {
    const ctx = setup({ env: { CLAUDE_CODE_ENTRYPOINT: entrypoint } });
    const r = await turn(ctx, { "pricing.py": PRICING });
    assert.equal(r.code, 0, `entrypoint ${entrypoint} should detach`);
    assert.equal(r.stdout + r.stderr, "", `entrypoint ${entrypoint} should produce nothing at Stop`);
    assert.ok(await waitFor(() => (readSessionFiles(ctx.data)[0] || { notes: [] }).notes.length > 0), `entrypoint ${entrypoint} should still deliver a note`);
  }
});

test("spend cap (429): nothing during the turn, one user-visible line at the next prompt, once", async () => {
  fp.state.submitStatus = { status: 429, code: "SPEND_CAP" };
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
  fs.writeFileSync(path.join(ctx.data, "config.json"), JSON.stringify({ keys: { [fp.url]: "ic_" + "Z".repeat(38) } }));
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(ctx.data, "config.json"), "utf8"));
  assert.ok(!cfg.keys || !cfg.keys[fp.url], "no per-service key");
  const cfile = path.join(ctx.data, "connect.json");
  assert.ok(await waitFor(() => fs.existsSync(cfile) && JSON.parse(fs.readFileSync(cfile, "utf8")).status === "pending", { timeoutMs: 10000 }));
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.match(next.json.systemMessage, /connect your account → http/);
});

test("prover unreachable: the turn is not held up, paths are kept, the next prompt says so once", async () => {
  const ctx = setup({ env: { INTENT_API_URL: "http://127.0.0.1:9" } });
  saveKey(ctx.data, TEST_KEY, "http://127.0.0.1:9");
  const r = await turn(ctx, { "pricing.py": PRICING });
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  const [s] = readSessionFiles(ctx.data);
  assert.deepEqual(s.touched, [path.join(ctx.repo, "pricing.py")]);
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "go on" }), ctx.env);
  assert.match(JSON.stringify(next.json), /couldn't reach the service, so recent changes haven't been checked yet/);
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  const again = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "and again" }), ctx.env);
  assert.doesNotMatch(JSON.stringify(again.json || {}), /couldn't reach/);
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
    saveKey(ctx.data, TEST_KEY, fp.url);
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

// Windows has no signals: kill() ends the process outright and no handler runs. The job is then picked
// up by "late result: a job whose runner died is delivered at the next prompt", which runs everywhere.
test("SIGTERM (hook timeout or quit): a detached finisher keeps polling and writes .intent/", { skip: process.platform === "win32" ? "a Node process cannot catch SIGTERM on Windows" : false }, async () => {
  fp.state.pollsBeforeDone = 1000;
  const ctx = setup();
  await turn(ctx, { "pricing.py": PRICING }, { run: false });
  const n = fp.state.requests.length;
  let child;
  const done = runHook("stop", fixture("stop", ctx.repo), ctx.env, { onSpawn: (c) => { child = c; } });
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/tasks/"))));
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
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/tasks/"))));
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
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/tasks/"))));
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
  assert.ok(await waitFor(() => fp.state.requests.slice(n).some((x) => x.method === "GET" && x.path.startsWith("/tasks/"))));
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

test("no git, no shadow baseline: diffs come from Claude Code's structuredPatch and the touched paths", async () => {
  const ctx = setup({ git: false });
  ctx.env.HOME = ctx.env.USERPROFILE = ctx.repo; // a project at the home directory is never snapshotted
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

test("a turn that only touches filtered-out files gets a skipped-files note, once per session", async () => {
  const ctx = setup();
  const n = fp.jobRequests().length;
  const css = "body {\n  color: red;\n}\n.a {\n  color: blue;\n}\n";
  const r = await turn(ctx, { "styles.css": css });
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  assert.equal(fp.jobRequests().length, n); // nothing was sent to the prover
  const next = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok" }), ctx.env);
  assert.equal(next.json.systemMessage, "Intent Check: skipped `styles.css` (styling, markup, tests, config or vendored code); it checks code with logic.");

  // A second filtered-out turn in the same session does not repeat the note.
  await turn(ctx, { "other.css": css });
  const again = await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "ok again" }), ctx.env);
  assert.equal(again.stdout, "");
});

test("old-Node shim: exits 0 with one stderr line when Node is older than 18", async () => {
  const pre = path.join(tmpdir(), "old-node.cjs");
  fs.writeFileSync(pre, "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '16.20.0' } });\n");
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["--require", pre, BIN, "prompt"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
    c.stdin.end("{}");
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Intent Check needs Node 18 or newer \(found 16\.20\.0\)[^\n]*\n\{"systemMessage":"[^\n]*"\}\n$/);
  const first = fs.readFileSync(BIN, "utf8").split("\n")[0];
  assert.doesNotMatch(first, /\?\.|\?\?|=>|\bconst\b|\blet\b|`/);
});

void sleep;

test("a worktree-isolated subagent's edit is reviewed under its repo path, not .claude/worktrees/", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "# todo\n");
  ctx.gitc("add", "-A");
  ctx.gitc("commit", "-qm", "pricing stub");
  ctx.gitc("worktree", "add", "-q", "-b", "agent-x", ".claude/worktrees/agent-x");
  const wt = path.join(ctx.repo, ".claude", "worktrees", "agent-x");
  const n = fp.jobRequests().length;
  await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "Add a helper that applies a percentage discount. It must never go below zero." }), ctx.env);
  const abs = path.join(wt, "pricing.py");
  fs.writeFileSync(abs, PRICING);
  await runHook("post-tool", fixture("post-tool-write", wt, { tool_input: { file_path: abs, content: PRICING }, agent_id: "a1", agent_type: "general-purpose" }), ctx.env);
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2, r.stderr);
  const [req] = jobsSince(n);
  assert.deepEqual(req.units.map((u) => u.path), ["pricing.py"]);
  assert.match(req.units[0].diff, /\n--- a\/pricing\.py\n\+\+\+ b\/pricing\.py\n/);
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "VERDICT.md")));
  assert.ok(!fs.existsSync(path.join(ctx.repo, ".intent", ".claude")));
  assert.doesNotMatch(r.stderr, /has changed since/); // stale check reads the worktree copy
});
