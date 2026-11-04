// Regression tests for the M2a review findings (numbered as in the review).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { QUIET_GLOBAL, fixture, tmpdir, makeRepo, baseEnv, runHook, saveKey, BIN } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver({ pollsBeforeDone: 0 }); await fp.listen(); });
after(() => fp.close());

test("3. merge conflict: the user's conflicted file is not uploaded as the agent's change", async () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, "shared.py"), "def f():\n    return 0\n");
  git("add", "-A"); git("commit", "-qm", "base");
  git("checkout", "-qb", "other");
  fs.writeFileSync(path.join(dir, "shared.py"), "def f():\n    return 1\n");
  git("commit", "-qam", "other");
  git("checkout", "-q", "-");
  fs.writeFileSync(path.join(dir, "shared.py"), "def f():\n    return 2\n");
  git("commit", "-qam", "main");
  try { git("merge", "other"); } catch { /* conflict expected */ }
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, fp.url);
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const env = baseEnv(data, fp.url);
  await runHook("prompt", fixture("prompt", dir), env);
  const abs = path.join(dir, "agent.py");
  fs.writeFileSync(abs, "def g(x):\n    y = x + 1\n    return y\n");
  await runHook("post-tool", fixture("post-tool-write", dir, { tool_input: { file_path: abs, content: "" } }), env);
  const n = fp.jobRequests().length;
  await runHook("stop", fixture("stop", dir), env);
  const [req] = fp.jobRequests().slice(n);
  assert.deepEqual(req.units.map((u) => u.path), ["agent.py"]);
});

test("4. native outbound context has no split surrogate pair, NUL or lone surrogate", async () => {
  const s = "a".repeat(3999) + "😀tail";
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, fp.url);
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const env = baseEnv(data, fp.url);
  const repo = makeRepo().dir;
  await runHook("prompt", fixture("prompt", repo, { prompt: s }), env);
  await runHook("prompt", fixture("prompt", repo, { prompt: "lone \ud800 and nul \u0000" }), env);
  fs.writeFileSync(path.join(repo, "a.py"), "x = 1\ny = 2\nz = 3\n");
  const n = fp.jobRequests().length;
  await runHook("stop", fixture("stop", repo), env);
  const [request] = fp.jobRequests().slice(n);
  assert.ok(request, "native review was submitted");
  assert.equal(request.intent.prompts[0].length, 3999);
  const json = JSON.stringify(request);
  assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(json), "no lone high surrogate");
  assert.ok(!json.includes("\\u0000"));
});

test("6. an unreachable service never slows a prompt: the request is created off the prompt path", async (t) => {
  const sockets = [];
  const hang = http.createServer(() => { /* never answers */ });
  hang.on("connection", (s) => sockets.push(s));
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  // Closed even when an assertion below fails: an open server would keep this test file from ever exiting.
  t.after(() => { for (const s of sockets) s.destroy(); hang.close(); });
  const url = `http://127.0.0.1:${hang.address().port}`;
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const env = baseEnv(data, url);
  const repo = makeRepo().dir;
  // A prompt that waited on the connect request would take its 1.5 s timeout plus process start-up;
  // Windows starts a node process more slowly, so its bound is looser but still below that.
  const FAST = process.platform === "win32" ? 1400 : 600;
  const first = await runHook("prompt", fixture("prompt", repo), env);
  assert.ok(first.ms < FAST, `first took ${first.ms}`);
  const second = await runHook("prompt", fixture("prompt", repo), env);
  const third = await runHook("prompt", fixture("prompt", repo, { session_id: "new-session" }), env);
  assert.ok(second.ms < FAST && third.ms < FAST, `${second.ms} ${third.ms}`);
});

test("8. a finisher exits when checks are turned off", async () => {
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, fp.url);
  const key = "0".repeat(32);
  fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(data, "sessions", `${key}.json`), JSON.stringify({ pending: [{ job_id: "A".repeat(22), url: "http://x/r/1", repo: tmpdir(), sent: [], submitted_at: Date.now() }] }));
  const t0 = Date.now();
  const code = await new Promise((resolve) => spawn(BIN, ["__worker", "--host", "claude-code", "finish", key], { env: baseEnv(data, fp.url, { INTENT_DISABLED: "1" }) }).on("close", resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(fp.state.requests.filter((r) => r.path === `/tasks/${"A".repeat(22)}`).length, 0);
});

test("9. after a 401 on an env key, later turns upload nothing", async () => {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const env = baseEnv(data, fp.url, { INTENT_API_KEY: "ic_" + "R".repeat(38) });
  const repo = makeRepo().dir;
  const posts = () => fp.state.requests.filter((r) => r.method === "POST" && r.path === "/intent-checks").length;
  const n = posts();
  const shown = [];
  for (const name of ["a", "b"]) {
    shown.push((await runHook("prompt", fixture("prompt", repo), env)).stdout);
    const abs = path.join(repo, `${name}.py`);
    fs.writeFileSync(abs, `def ${name}(x):\n    y = x\n    return y\n`);
    await runHook("post-tool", fixture("post-tool-write", repo, { tool_input: { file_path: abs, content: "" } }), env);
    await runHook("stop", fixture("stop", repo), env);
  }
  assert.equal(posts() - n, 1);
  assert.match(shown[1], /INTENT_API_KEY was not accepted/);
});

test("re-review: while paused, one note per session; an env-key pause expires after 24 h", async () => {
  const data = tmpdir("intent-data-");
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const env = baseEnv(data, fp.url, { INTENT_API_KEY: "ic_" + "P".repeat(38) });
  const repo = makeRepo().dir;
  const posts = () => fp.state.requests.filter((r) => r.method === "POST" && r.path === "/intent-checks").length;
  const edit = async (name, session) => {
    const outp = await runHook("prompt", fixture("prompt", repo, { session_id: session }), env);
    const abs = path.join(repo, `${name}.py`);
    fs.writeFileSync(abs, `def ${name}(x):\n    y = x\n    return y\n`);
    await runHook("post-tool", fixture("post-tool-write", repo, { session_id: session, tool_input: { file_path: abs, content: "" } }), env);
    await runHook("stop", fixture("stop", repo, { session_id: session }), env);
    return outp.stdout;
  };
  const n = posts();
  await edit("a", "s1");
  await edit("b", "s1");
  const s1 = await runHook("prompt", fixture("prompt", repo, { session_id: "s1" }), env);
  assert.equal(posts() - n, 1);
  assert.equal((s1.stdout.match(/paused/g) || []).length, 0, "already told this session");
  // A new session is told once.
  await edit("c", "s2");
  const s2 = await runHook("prompt", fixture("prompt", repo, { session_id: "s2" }), env);
  assert.match(s2.json.systemMessage, /checks are paused because the API key was not accepted/);
  assert.equal(posts() - n, 1);
  // After 24 h the env-key pause lapses and the next turn tries again.
  const g = JSON.parse(fs.readFileSync(path.join(data, "global.json"), "utf8"));
  g.paused.at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(data, "global.json"), JSON.stringify(g));
  await edit("d", "s2");
  assert.equal(posts() - n, 2);
});
