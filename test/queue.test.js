// M2b: `intent check` queue (S5) and renames/deletes of unit folders.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { symlink, QUIET_GLOBAL, fixture, tmpdir, makeRepo, baseEnv, runHook, saveKey, BIN, ROOT, xdgDir } from "./helpers/env.js";
import { validateDef } from "./helpers/schema.js";
import { writeUnit } from "../lib/intentdir.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));

const example = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "api", "examples", "status-done-concerns.json"), "utf8"));

function setup() {
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, fp.url);
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const { dir, git } = makeRepo();
  return { data, repo: dir, git, env: baseEnv(data, fp.url) };
}

// Run the CLI the way an agent's shell would: no plugin env vars, cwd in the repo.
// data: the plugin data dir, passed as --data like the /intent:deepscan command does.
function cli(args, cwd, data) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_") && !k.startsWith("INTENT_")));
    // HOME points at a throwaway dir so a failing run cannot log into the real plugin data dir.
    const c = spawn(process.execPath, [BIN, "deepscan", ...args, ...(data ? ["--data", data] : [])], { cwd, env: { ...env, HOME: tmpdir("intent-home-"), XDG_CONFIG_HOME: data ? xdgDir(data) : undefined, INTENT_API_URL: fp.url } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

const queueFiles = (repo) => {
  try { return fs.readdirSync(path.join(repo, ".intent", ".queue")); } catch { return []; }
};

test("intent deepscan <files> queues validated repo-relative paths, offline, and says so in one line", async () => {
  const { repo, data } = setup();
  fs.mkdirSync(path.join(repo, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "auth", "login.py"), "def login(u, p):\n    return check(u, p)\n");
  fs.writeFileSync(path.join(repo, ".env"), "KEY=1\n");
  const n = fp.state.requests.length;
  const outside = path.join(tmpdir("intent-outside-"), "passwd"); // an absolute path that exists on every platform
  fs.writeFileSync(outside, "root:x:0:0\n");
  const r = await cli(["login.py", "../../.env", "missing.py", outside], path.join(repo, "src", "auth"), data);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Intent Check: queued a review of 1 file; it runs in the background/);
  assert.match(r.out, /secrets file/);
  assert.match(r.out, /not found/);
  assert.match(r.out, /outside the repo/);
  const [q] = queueFiles(repo);
  const item = JSON.parse(fs.readFileSync(path.join(repo, ".intent", ".queue", q), "utf8"));
  assert.deepEqual([item.mode, item.paths], ["request", ["src/auth/login.py"]]);
  assert.equal(fp.state.requests.length, n, "the CLI never calls the service");
  // .queue is ignored by git.
  assert.equal(fs.readFileSync(path.join(repo, ".intent", ".gitignore"), "utf8"), ".sent.log\n.queue\n");
  // A depth word is not a file, and says so; a flag is refused.
  const deep = await cli(["src/auth/login.py", "full"], repo, data);
  assert.match(deep.out, /queued a review of 1 file.*The depth only applies to a whole-repo or folder scan\./);
  assert.match((await cli(["--scope", "src"], repo, data)).out, /--scope is not a DeepScan option/);
  assert.match((await cli(["src", "src/auth/login.py"], repo, data)).out, /files or one folder, not both/);
});

test("S5: a queued request is submitted at the next Stop as a request job without a diff", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "def apply_discount(p, d):\n    return p - p * d // 100\n");
  ctx.git("add", "-A"); ctx.git("commit", "-qm", "pricing");
  await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "is apply_discount right?" }), ctx.env);
  await cli(["pricing.py"], ctx.repo, ctx.data);
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2, r.stderr);
  const [req] = fp.jobRequests().slice(n);
  assert.deepEqual(validateDef(req, "JobRequest"), []);
  assert.equal(req.mode, "request");
  assert.equal(req.units[0].diff, null);
  assert.equal(req.changed_lines, 0);
  assert.deepEqual(queueFiles(ctx.repo), []);
  const log = fs.readFileSync(path.join(ctx.repo, ".intent", ".sent.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(log.at(-1).mode, "request");
});

test("a file both edited and queued goes only into the request job", async () => {
  const ctx = setup();
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  const abs = path.join(ctx.repo, "calc.py");
  fs.writeFileSync(abs, "def add(a, b):\n    c = a + b\n    return c\n");
  await runHook("post-tool", fixture("post-tool-write", ctx.repo, { tool_input: { file_path: abs, content: "" } }), ctx.env);
  await cli(["calc.py"], ctx.repo, ctx.data);
  const n = fp.jobRequests().length;
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.deepEqual(fp.jobRequests().slice(n).map((r) => r.mode), ["request"]);
});

test("a symlinked queue folder or queue file is refused", async () => {
  const { repo, data } = setup();
  fs.writeFileSync(path.join(repo, "a.py"), "A = 1\n");
  const outside = tmpdir("intent-outside-");
  fs.mkdirSync(path.join(repo, ".intent"));
  symlink(outside, path.join(repo, ".intent", ".queue"));
  const r = await cli(["a.py"], repo, data);
  assert.match(r.out, /could not queue/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("renames move unit folders and deletions remove them; foreign files are left alone", async () => {
  const ctx = setup();
  for (const f of ["old.py", "gone.py", "keep.py"]) fs.writeFileSync(path.join(ctx.repo, f), `V = "${f}"\n`);
  ctx.git("add", "-A"); ctx.git("commit", "-qm", "files");
  for (const f of ["old.py", "gone.py", "keep.py"]) writeUnit(ctx.repo, { ...example.result.units[0], path: f }, { job_id: "j", url: "u" }, example.result);
  fs.writeFileSync(path.join(ctx.repo, ".intent", "keep.py", "NOTES.txt"), "mine\n");
  ctx.git("add", "-A"); ctx.git("commit", "-qm", "intent");
  await runHook("prompt", fixture("prompt", ctx.repo), ctx.env);
  ctx.git("mv", "old.py", "new.py");
  fs.unlinkSync(path.join(ctx.repo, "gone.py"));
  fs.unlinkSync(path.join(ctx.repo, "keep.py"));
  await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  const d = path.join(ctx.repo, ".intent");
  assert.ok(fs.existsSync(path.join(d, "new.py", "SPEC.k")));
  assert.equal(fs.existsSync(path.join(d, "old.py")), false);
  assert.equal(fs.existsSync(path.join(d, "gone.py")), false);
  assert.ok(fs.existsSync(path.join(d, "keep.py", "NOTES.txt")), "a folder with foreign files is not touched");
});

test("intent deepscan <files> inside a worktree-isolated subagent is queued in the main repo and reviewed under the repo path", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.repo, "pricing.py"), "# todo\n");
  ctx.git("add", "-A"); ctx.git("commit", "-qm", "pricing");
  ctx.git("worktree", "add", "-q", "-b", "agent-q", ".claude/worktrees/agent-q");
  const wt = path.join(ctx.repo, ".claude", "worktrees", "agent-q");
  fs.writeFileSync(path.join(wt, "pricing.py"), "def apply_discount(p, d):\n    return p - p * d // 100\n");
  await runHook("prompt", fixture("prompt", ctx.repo, { prompt: "is apply_discount right?" }), ctx.env);
  const out = await cli(["pricing.py"], wt, ctx.data);
  assert.match(out.out, /queued a review of 1 file/);
  assert.deepEqual(queueFiles(wt), []);
  const [q] = queueFiles(ctx.repo);
  const item = JSON.parse(fs.readFileSync(path.join(ctx.repo, ".intent", ".queue", q), "utf8"));
  assert.deepEqual([item.paths, item.worktree], [["pricing.py"], fs.realpathSync(wt)]);
  const n = fp.jobRequests().length;
  const r = await runHook("stop", fixture("stop", ctx.repo), ctx.env);
  assert.equal(r.code, 2, r.stderr);
  const [req] = fp.jobRequests().slice(n);
  assert.equal(req.mode, "request");
  assert.equal(req.units[0].path, "pricing.py");
  assert.match(req.units[0].content, /apply_discount/); // the worktree's copy, not the main tree's
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "meta.json")));
  assert.ok(!fs.existsSync(path.join(ctx.repo, ".intent", ".claude")));
});

test("a queued item naming a folder outside the repo's worktrees is dropped", async () => {
  const ctx = setup();
  const outside = tmpdir("intent-outside-");
  fs.writeFileSync(path.join(outside, "passwd"), "root:x:0:0\n");
  fs.mkdirSync(path.join(ctx.repo, ".intent", ".queue"), { recursive: true });
  fs.writeFileSync(path.join(ctx.repo, ".intent", ".queue", "1-deadbeef.json"), JSON.stringify({ mode: "request", paths: ["passwd"], worktree: outside }));
  const { takeQueue } = await import("../lib/queue.js");
  assert.deepEqual(takeQueue(ctx.repo), []);
});
