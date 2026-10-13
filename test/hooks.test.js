// Replays the captured Claude Code payloads through bin/intent.js, like Claude Code runs it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { fixture, tmpdir, makeRepo, baseEnv, runHook, readSessionFiles, saveKey } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());

function setup({ key = true, git = true } = {}) {
  const data = tmpdir("intent-data-");
  if (key) saveKey(data, TEST_KEY);
  const repo = makeRepo({ git });
  return { data, repo: repo.dir, env: baseEnv(data, fp.url) };
}

test("SessionStart: consent notice once per machine, shown to the user", async () => {
  const { data, repo, env } = setup();
  const r1 = await runHook("session-start", fixture("session-start", repo), env);
  assert.equal(r1.code, 0);
  assert.match(r1.json.systemMessage, /^Intent Check is on\./);
  assert.match(r1.json.systemMessage, /\.intent\/\.sent\.log/);
  assert.match(r1.json.systemMessage, /\/intent:off/);
  assert.equal(r1.json.hookSpecificOutput.hookEventName, "SessionStart");
  const r2 = await runHook("session-start", fixture("session-start", repo, { session_id: "other" }), env);
  assert.equal(r2.stdout, "");
  assert.ok(fs.existsSync(path.join(data, "global.json")));
});

test("UserPromptSubmit: consent also on the first prompt (install session has no SessionStart)", async () => {
  const { repo, env } = setup();
  const r = await runHook("prompt", fixture("prompt", repo), env);
  assert.equal(r.code, 0);
  assert.match(r.json.systemMessage, /^Intent Check is on\./);
  const r2 = await runHook("prompt", fixture("prompt", repo), env);
  assert.equal(r2.stdout, "");
});

test("UserPromptSubmit: ring buffer of the last 4 real prompts; task notifications and our commands are skipped", async () => {
  const { data, repo, env } = setup();
  const prompts = ["first substantive prompt about pricing", "p2", "p3", "p4", "p5"];
  for (const p of prompts) await runHook("prompt", fixture("prompt", repo, { prompt: p }), env);
  await runHook("prompt", fixture("prompt-task-notification", repo), env);
  await runHook("prompt", fixture("prompt", repo, { prompt: "/intent:off" }), env);
  const [s] = readSessionFiles(data);
  assert.deepEqual(s.prompts, ["p2", "p3", "p4", "p5"]);
  assert.equal(s.first_prompt, "first substantive prompt about pricing");
  assert.equal(s.permission_mode, "acceptEdits");
  assert.match(s.baseline.sha, /^[0-9a-f]{40}$/);
  assert.equal(s.baseline.repo, repo);
});

test("UserPromptSubmit: harness-injected blocks are not prompts; text typed after them is kept", async () => {
  const { data, repo, env } = setup();
  const block = "<browser_instruction># Claude in Chrome browser automation\nUse the tools. ".repeat(1) + "x".repeat(4000) + "</browser_instruction>";
  await runHook("prompt", fixture("prompt", repo, { prompt: block }), env);
  assert.deepEqual(readSessionFiles(data)[0].prompts, []);
  await runHook("prompt", fixture("prompt", repo, { prompt: `${block}\n\n<system-reminder>ctx</system-reminder>\nAdd a login form to the page` }), env);
  await runHook("prompt", fixture("prompt", repo, { prompt: "a normal <b>prompt</b> about the form" }), env);
  const [s] = readSessionFiles(data);
  assert.deepEqual(s.prompts, ["Add a login form to the page", "a normal <b>prompt</b> about the form"]);
  assert.equal(s.first_prompt, "Add a login form to the page");
});

test("UserPromptSubmit: git baseline is a stash commit when the tree is dirty, HEAD when clean", async () => {
  const { data, repo, env } = setup();
  await runHook("prompt", fixture("prompt", repo), env);
  const head = readSessionFiles(data)[0].baseline;
  assert.equal(head.sha, head.head);
  fs.writeFileSync(path.join(repo, "README.md"), "# changed\n");
  await runHook("prompt", fixture("prompt", repo), env);
  const dirty = readSessionFiles(data)[0].baseline;
  assert.notEqual(dirty.sha, dirty.head);
  // The stash list is untouched.
  assert.equal(fs.existsSync(path.join(repo, ".git", "refs", "stash")), false);
});

test("PostToolUse: records Edit/Write/NotebookEdit paths, plan and todos", async () => {
  const { data, repo, env } = setup();
  for (const f of ["post-tool-edit", "post-tool-write", "post-tool-notebook-edit", "post-tool-exit-plan-mode", "post-tool-todo-write", "post-tool-edit"]) {
    const r = await runHook("post-tool", fixture(f, repo), env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
  const [s] = readSessionFiles(data);
  assert.deepEqual(s.touched, [`${repo}/calc.py`, `${repo}/notes.py`, `${repo}/analysis.ipynb`]);
  assert.match(s.plan, /apply_discount/);
  assert.deepEqual(s.todos, ["Add apply_discount", "Clamp the result at zero"]);
  // No baseline yet, so structuredPatch was kept as the diff source.
  assert.equal(s.patches[`${repo}/calc.py`].length, 2);
});

test("Stop without an API key sends nothing and exits 0", async () => {
  const { repo, env } = setup({ key: false });
  fs.writeFileSync(path.join(repo, "calc.py"), "def a():\n    return 1\n\ndef b():\n    return 2\n");
  const before = fp.jobRequests().length;
  await runHook("post-tool", fixture("post-tool-edit", repo), env);
  const r = await runHook("stop", fixture("stop", repo), env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, "");
  assert.equal(fp.jobRequests().length, before);
});

test("bad input never fails a hook", async () => {
  const { env } = setup();
  for (const ev of ["session-start", "prompt", "post-tool", "stop", "nonsense"]) {
    const r = await runHook(ev, undefined, env);
    assert.equal(r.code, 0, ev);
  }
  const r = await runHook("prompt", "not json", env);
  assert.equal(r.code, 0);
});

test("sync hooks stay fast", async () => {
  const { repo, env } = setup();
  await runHook("prompt", fixture("prompt", repo), env);
  const times = { prompt: [], "post-tool": [] };
  for (let i = 0; i < 3; i++) {
    times.prompt.push((await runHook("prompt", fixture("prompt", repo), env)).ms);
    times["post-tool"].push((await runHook("post-tool", fixture("post-tool-edit", repo), env)).ms);
  }
  const best = (a) => Math.min(...a);
  // Includes Node start-up (~50 ms); the budget for the hook's own work is 200 ms. Windows starts node
  // and git processes several times more slowly (a CI runner's best prompt run is about 700 ms).
  assert.ok(best(times.prompt) < (process.platform === "win32" ? 1200 : 600), JSON.stringify(times));
  assert.ok(best(times["post-tool"]) < 400, JSON.stringify(times));
});
