// Regression tests for the PR #6 (M2b) review findings.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { reviewPath, symlink, QUIET_GLOBAL, fixture, tmpdir, makeRepo, baseEnv, runHook, saveKey, seedReview, seedPause, readSessionFiles, waitFor, BIN, ROOT, xdgDir } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));

const example = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "api", "examples", "status-done-concerns.json"), "utf8"));
const unit = (root, p) => seedReview(root, { ...example.result.units[0], path: p }, { job_id: "j", url: "u" }, example.result);

function setup({ key = true, git = true, env = {} } = {}) {
  const data = tmpdir("intent-data-");
  if (key) saveKey(data, TEST_KEY, fp.url);
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const { dir, git: g } = makeRepo({ git });
  return { data, repo: dir, git: g, env: baseEnv(data, fp.url, env) };
}

function cli(args, cwd, data, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_") && !k.startsWith("INTENT_") && k !== "DO_NOT_TRACK"));
    const c = spawn(BIN, ["deepscan", ...args, "--data", data], { cwd, env: { ...env, HOME: tmpdir("intent-home-"), XDG_CONFIG_HOME: xdgDir(data), INTENT_API_URL: fp.url, ...extraEnv } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", () => resolve(out.trim()));
  });
}

const queueFiles = (repo) => {
  try { return fs.readdirSync(path.join(repo, ".intent", ".queue")); } catch { return []; }
};

test("2. history stays when git reports deletion or rename but the old file exists again", async () => {
  const ctx = setup();
  const { repo } = ctx;
  for (const f of ["kept.py", "back.py"]) {
    fs.writeFileSync(path.join(repo, f), "X = 1\n");
    unit(repo, f);
  }
  ctx.git("add", "kept.py", "back.py");
  ctx.git("commit", "-qm", "source files");
  await runHook("prompt", fixture("prompt", repo), ctx.env);
  ctx.git("rm", "--cached", "kept.py");
  ctx.git("mv", "back.py", "moved.py");
  fs.writeFileSync(path.join(repo, "back.py"), "X = 1\n");
  await runHook("stop", fixture("stop", repo), ctx.env);
  assert.ok(fs.existsSync(path.join(repo, ".intent/files/kept.py/checks/j/SPEC.k")));
  assert.ok(fs.existsSync(path.join(repo, ".intent/files/back.py/checks/j/SPEC.k")));
  assert.equal(fs.existsSync(path.join(repo, ".intent/files/moved.py/checks/j")), false, "old evidence must not be rebound to the renamed source");
});

test("3. queued reviews survive a transient submit failure and go out at the next Stop", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "a.py"), "A = 1\n");
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  assert.match(await cli(["a.py"], ctx.repo, ctx.data), /queued a review of 1 file/);
  fp.state.submitStatus = { status: 503, code: "internal" };
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(queueFiles(ctx.repo).length, 1, "back in the queue");
  fp.state.submitStatus = null;
  const n = fp.jobRequests().length;
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.deepEqual(fp.jobRequests().slice(n).map((r) => r.mode), ["request"]);
  assert.equal(queueFiles(ctx.repo).length, 0);
});

test("4. intent deepscan <files> says so when off, not connected or paused, and queues nothing; Stop drops the queue while off", async () => {
  const off = setup({ env: {} });
  fs.writeFileSync(path.join(off.repo, "a.py"), "A = 1\n");
  assert.match(await cli(["a.py"], off.repo, off.data, { INTENT_DISABLED: "1" }), /^Intent Check is off, so nothing was queued/);
  const nokey = setup({ key: false });
  fs.writeFileSync(path.join(nokey.repo, "a.py"), "A = 1\n");
  assert.match(await cli(["a.py"], nokey.repo, nokey.data), /not connected yet, so nothing was queued/);
  const paused = setup();
  fs.writeFileSync(path.join(paused.repo, "a.py"), "A = 1\n");
  seedPause(paused.data, TEST_KEY, 401);
  assert.match(await cli(["a.py"], paused.repo, paused.data), /paused/);
  for (const c of [off, nokey, paused]) assert.equal(queueFiles(c.repo).length, 0);
  // Queued while on, then turned off: the Stop discards it.
  const later = setup({ env: { INTENT_DISABLED: "1" } });
  fs.writeFileSync(path.join(later.repo, "a.py"), "A = 1\n");
  assert.match(await cli(["a.py"], later.repo, later.data), /queued/);
  const n = fp.jobRequests().length;
  await runHook("stop", fixture("stop", later.repo), later.env);
  assert.equal(queueFiles(later.repo).length, 0);
  assert.equal(fp.jobRequests().length, n);
});

test("5. a non-git folder reached through a symlink still sends its queued reviews", async () => {
  const ctx = setup({ git: false });
  fs.writeFileSync(path.join(ctx.repo, "a.py"), "A = 1\n");
  const link = path.join(tmpdir("intent-link-"), "proj");
  symlink(ctx.repo, link);
  assert.match(await cli(["a.py"], link, ctx.data), /queued a review of 1 file/);
  const n = fp.jobRequests().length;
  await runHook("stop", fixture("stop", link), ctx.env);
  const [req] = fp.jobRequests().slice(n);
  assert.deepEqual(req && req.units.map((u) => u.path), ["a.py"]);
});

test("6. after a wake, other running jobs are finished by a detached finisher", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "queued.py"), "Q = 1\n");
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  await cli(["queued.py"], ctx.repo, ctx.data);
  const abs = path.join(ctx.repo, "edited.py");
  fs.writeFileSync(abs, "def e(x):\n    y = x\n    return y\n");
  await runHook("post-tool", fixture("post-tool-write", ctx.repo, { tool_input: { file_path: abs, content: "" } }), ctx.env);
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2);
  // The second job's result arrives anyway: written to .intent/ and left as a note.
  assert.ok(await waitFor(() => fs.existsSync(reviewPath(ctx.repo, "queued.py", "VERDICT.md")), { timeoutMs: 15000 }));
  assert.ok(await waitFor(() => (readSessionFiles(ctx.data)[0] || { notes: [] }).notes.length > 0, { timeoutMs: 15000 }));
});

test("r2-1: a failing queued review keeps its id and Idempotency-Key, is retried at most 3 times, and does not block others", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "bad.py"), "B = 1\n");
  fs.writeFileSync(path.join(ctx.repo, "good.py"), "G = 1\n");
  assert.match(await cli(["bad.py"], ctx.repo, ctx.data), /queued/);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(await cli(["good.py"], ctx.repo, ctx.data), /queued/);
  // The fake answers 500 for any job that contains bad.py.
  const keys = [];
  fp.state.failPath = "bad.py";
  const shown = [];
  for (let i = 0; i < 4; i++) {
    shown.push((await runHook("prompt", fixture("prompt", ctx.repo), ctx.env)).stdout);
    await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  }
  const posts = fp.state.requests.filter((r) => r.method === "POST" && r.path === "/intent-checks" && r.body && r.body.units && r.body.units[0].path === "bad.py");
  for (const p of posts) keys.push(p.headers["idempotency-key"]);
  assert.equal(posts.length, 3, "three attempts, then dropped");
  assert.equal(new Set(keys).size, 1, "same Idempotency-Key on every retry");
  const good = fp.state.requests.filter((r) => r.method === "POST" && r.path === "/intent-checks" && r.body && r.body.units && r.body.units[0].path === "good.py");
  assert.equal(good.length, 1, "the healthy review went out on the first Stop");
  assert.equal(queueFiles(ctx.repo).length, 0);
  assert.match(shown.join("\n"), /gave up on a requested review of 1 file after 3 failed attempts/);
  delete fp.state.failPath;
});

test("r2-3: native off fails loudly when the data folder is not writable", async () => {
  const file = path.join(tmpdir(), "not-a-dir");
  fs.writeFileSync(file, "");
  const r = await new Promise((resolve) => {
    const c = spawn(BIN, ["off", "--data", path.join(file, "data")]);
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => resolve({ code, out, err }));
  });
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /could not turn checks off.*INTENT_DISABLED=1/);
});

test("r3-a: one root rule: git top level, else the current folder (no walk-up, no walk-down)", async () => {
  const parent = tmpdir("intent-nogit-");
  fs.mkdirSync(path.join(parent, ".intent"));
  fs.mkdirSync(path.join(parent, "sub"));
  const subData = tmpdir("intent-data-");
  saveKey(subData, TEST_KEY, fp.url);
  fs.writeFileSync(path.join(parent, "sub", "a.py"), "X = 1\n");
  assert.match(await cli(["a.py"], path.join(parent, "sub"), subData), /queued a review of 1 file/);
  assert.equal(queueFiles(parent).length, 0, "no walk-up to a parent .intent/");
  assert.equal(queueFiles(path.join(parent, "sub")).length, 1);
  // A non-git parent session never touches a nested git repo's .intent/.
  const nested = path.join(parent, "code");
  fs.mkdirSync(nested);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: nested });
  fs.mkdirSync(path.join(nested, ".intent", ".queue"), { recursive: true });
  for (const f of ["README.md", ".ignore", ".gitignore"]) fs.writeFileSync(path.join(nested, ".intent", f), "x\n");
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, fp.url);
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  await runHook("stop", fixture("stop", parent), baseEnv(data, fp.url));
  for (const f of ["README.md", ".ignore", ".gitignore"]) assert.ok(fs.existsSync(path.join(nested, ".intent", f)), f);
});

test("r3-3: an unreachable service does not use up retries; untried items go back unchanged", async () => {
  const ctx = setup({ env: { INTENT_API_URL: "http://127.0.0.1:9" } });
  for (const f of ["a.py", "b.py"]) fs.writeFileSync(path.join(ctx.repo, f), "X = 1\n");
  assert.match(await cli(["a.py"], ctx.repo, ctx.data), /queued/);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(await cli(["b.py"], ctx.repo, ctx.data), /queued/);
  for (let i = 0; i < 3; i++) {
    await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
    await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  }
  const files = queueFiles(ctx.repo);
  assert.equal(files.length, 2, "both still queued");
  for (const f of files) assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.repo, ".intent", ".queue", f), "utf8")).attempts, 0, f);
});

test("r3-5: a failed 'on' does not suggest INTENT_DISABLED", async () => {
  const file = path.join(tmpdir(), "not-a-dir");
  fs.writeFileSync(file, "");
  const err = await new Promise((resolve) => {
    const c = spawn(BIN, ["on", "--data", path.join(file, "data")]);
    let e = "";
    c.stderr.on("data", (d) => { e += d; });
    c.on("close", (code) => resolve({ code, e }));
  });
  assert.equal(err.code, 1);
  assert.match(err.e, /could not turn checks on/);
  assert.doesNotMatch(err.e, /INTENT_DISABLED/);
});
