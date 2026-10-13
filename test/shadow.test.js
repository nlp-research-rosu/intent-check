// Shadow snapshots: shell-written files are found at Stop in a project with no git baseline
// (not a repo, or a repo with no commit), diffed against the prompt-time state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir, makeRepo } from "./helpers/env.js";
import { collectChanges, shadowCandidate } from "../lib/changes.js";
import * as shadow from "../lib/shadow.js";

const F = (n, extra = "") => Array.from({ length: 5 }, (_, i) => `def f${n}_${i}(x):\n    return x * ${i + 2}${extra}\n`).join("\n");
const put = (dir, rel, c) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), c); };

function withData(fn) {
  return async () => {
    const prev = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = tmpdir("intent-shadow-data-");
    try { await fn(); } finally { if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev; }
  };
}

const snap = (dir) => shadow.snapshot(dir, shadowCandidate);

async function scenario(dir) {
  put(dir, "user_edited.py", F(1));
  put(dir, "calc.py", F(2));
  put(dir, "node_modules/dep/index.js", F(3));
  const sh = await snap(dir);
  assert.ok(sh && /^[0-9a-f]{40,64}$/.test(sh.tree));
  return { sh, baseline: { sha: null, head: null, shadow: sh } };
}

for (const mode of ["not a repo", "repo without commits"]) {
  test(`shadow: ${mode}: shell changes, new files; not pre-prompt state, not node_modules`, withData(async () => {
    const dir = mode === "not a repo" ? makeRepo({ git: false }).dir : makeRepo({ git: true, commit: false }).dir;
    const { baseline } = await scenario(dir);
    put(dir, "calc.py", F(2) + "\ndef extra(x):\n    y = x + 1\n    return y\n"); // shell edit of an existing file
    put(dir, "fresh.py", F(4));
    put(dir, "node_modules/dep/index.js", F(3, "+1"));
    const ch = await collectChanges({ baseline, touched: [], patches: {} }, dir);
    assert.equal(ch.shadow, true);
    assert.deepEqual(ch.files.map((f) => f.rel).sort(), ["calc.py", "fresh.py"]);
    const calc = ch.files.find((f) => f.rel === "calc.py");
    assert.match(calc.diff, /^diff --git/);
    assert.equal(calc.changed, 4);
    assert.doesNotMatch(calc.diff, /^\+def f2_0/m);
    assert.match(ch.files.find((f) => f.rel === "fresh.py").diff, /^--- \/dev\/null/);
  }));
}

test("shadow: a file the user edited before the prompt is not collected", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "mine.py", F(1));
  put(dir, "mine.py", F(1, " + 100")); // the user's own edit, before the snapshot
  const sh = await snap(dir);
  const ch = await collectChanges({ baseline: { sha: null, shadow: sh }, touched: [], patches: {} }, dir);
  assert.deepEqual(ch.files, []);
}));

test("shadow: an Edit-touched file also changed by a shell command has one diff with both changes", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "a.py", F(1));
  const sh = await snap(dir);
  put(dir, "a.py", F(1).replace("x * 2", "x * 20")); // the Edit tool
  put(dir, "a.py", fs.readFileSync(path.join(dir, "a.py"), "utf8").replace("x * 3", "x * 30")); // then sed -i
  const ch = await collectChanges({ baseline: { sha: null, shadow: sh }, touched: [path.join(dir, "a.py")], patches: {} }, dir);
  assert.equal(ch.files.length, 1);
  assert.equal((ch.files[0].diff.match(/^\+    return x \* (20|30)/gm) || []).length, 2);
}));

test("shadow: a touched file outside the snapshot keeps today's patch-based diff", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "keep.py", F(1));
  const sh = await snap(dir);
  put(dir, "tests/test_x.py", F(9));
  const ch = await collectChanges({ baseline: { sha: null, shadow: sh }, touched: [path.join(dir, "tests/test_x.py")], patches: {} }, dir);
  assert.equal(ch.files.length, 0); // test files are skipped, but this must not throw
}));

test("shadow: deleted files are not collected", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "gone.py", F(1));
  const sh = await snap(dir);
  fs.unlinkSync(path.join(dir, "gone.py"));
  const ch = await collectChanges({ baseline: { sha: null, shadow: sh }, touched: [], patches: {} }, dir);
  assert.deepEqual(ch.files, []);
  assert.deepEqual(ch.deleted, ["gone.py"]);
}));

test("shadow: the project's own git state is untouched", withData(async () => {
  const { dir, git } = makeRepo({ git: true, commit: false });
  put(dir, "a.py", F(1));
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString();
  const idx = fs.existsSync(path.join(dir, ".git", "index")) ? fs.readFileSync(path.join(dir, ".git", "index")) : null;
  await snap(dir);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString(), before);
  assert.equal(fs.existsSync(path.join(dir, ".git", "index")) ? fs.readFileSync(path.join(dir, ".git", "index")).equals(idx) : idx === null, true);
  assert.equal(execFileSync("git", ["stash", "list"], { cwd: dir }).toString(), "");
  void git;
}));

test("shadow: more candidate files than the cap gives no snapshot", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  for (let i = 0; i < shadow.MAX_SHADOW_FILES + 1; i++) put(dir, `d${i % 20}/f${i}.py`, "x = 1\n");
  assert.equal(await snap(dir), null);
}));

test("shadow: the home directory and a filesystem root are never snapshotted", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "a.py", F(1));
  const prev = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = process.env.USERPROFILE = dir;
  try {
    assert.equal(shadow.rootAllowed(dir), false);
    assert.equal(await snap(dir), null);
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = prev;
    if (prev[0] === undefined) delete process.env.HOME;
    if (prev[1] === undefined) delete process.env.USERPROFILE;
  }
  assert.equal(shadow.rootAllowed(path.parse(dir).root), false);
}));

test("shadow: dirs unused for 30 days are removed", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "a.py", F(1));
  const sh = await snap(dir);
  shadow.gcShadows(Date.now() + 10 * 24 * 3600 * 1000);
  assert.ok(fs.existsSync(sh.dir));
  shadow.gcShadows(Date.now() + 40 * 24 * 3600 * 1000);
  assert.ok(!fs.existsSync(sh.dir));
}));

test("shadow: a git repo with commits: a tracked file modified by a shell is found via the git baseline", withData(async () => {
  const { dir, git } = makeRepo({ git: true });
  put(dir, "t.py", F(1));
  git("add", "-A"); git("commit", "-qm", "t");
  const { captureBaseline } = await import("../lib/git.js");
  const b = await captureBaseline(dir);
  put(dir, "t.py", F(1) + "\ndef more(x):\n    y = x\n    return y\n");
  const ch = await collectChanges({ baseline: { repo: dir, sha: b.sha, head: b.head, untracked: {} }, touched: [], patches: {} }, dir);
  assert.equal(ch.git, true);
  assert.deepEqual(ch.files.map((f) => f.rel), ["t.py"]);
}));

test("shadow: touched files the walk never records (dot-dirs, vendor-like dirs, nested repos) are still reviewed", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "keep.py", F(1));
  fs.mkdirSync(path.join(dir, "sub", ".git"), { recursive: true });
  const sh = await snap(dir);
  const rels = [".github/scripts/ci.py", "out/gen.py", "sub/lib.py"];
  for (const r of rels) put(dir, r, F(5));
  const ch = await collectChanges({ baseline: { sha: null, shadow: sh }, touched: rels.map((r) => path.join(dir, r)), patches: {} }, dir);
  assert.deepEqual(ch.files.map((f) => f.rel).sort(), rels.slice().sort());
}));

test("shadow: a failure is remembered, and stale temp files are swept", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  for (let i = 0; i < shadow.MAX_SHADOW_FILES + 1; i++) put(dir, `d${i % 20}/f${i}.py`, "x = 1\n");
  assert.equal(await snap(dir), null);
  assert.ok(fs.existsSync(path.join(shadow.shadowDirFor(dir), "fail")));
  for (let i = 0; i < 30; i++) fs.unlinkSync(path.join(dir, `d${i % 20}/f${i}.py`)); // still over the cap, but...
  const t0 = Date.now();
  assert.equal(await snap(dir), null); // skipped by the marker without a walk
  assert.ok(Date.now() - t0 < 200);
  const sd = shadow.shadowDirFor(dir);
  const old = path.join(sd, "index.123-dead");
  fs.writeFileSync(old, "x");
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  fs.rmSync(path.join(sd, "fail"));
  await snap(dir);
  assert.ok(!fs.existsSync(old));
}));

test("shadow: an unreadable file does not lose the snapshot", { skip: process.platform === "win32" || (process.getuid && process.getuid() === 0) }, withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  put(dir, "ok.py", F(1));
  put(dir, "locked.py", F(2));
  fs.chmodSync(path.join(dir, "locked.py"), 0);
  const sh = await snap(dir);
  assert.ok(sh);
}));

test("shadow: clean filters from the user's git config and .gitattributes do not run", withData(async () => {
  const dir = makeRepo({ git: false }).dir;
  const home = tmpdir("intent-shadow-home-");
  const marker = path.join(home, "ran");
  fs.writeFileSync(path.join(home, ".gitconfig"), `[filter "foo"]\n\tclean = touch ${marker.split(path.sep).join("/")}; cat\n`); // git runs the filter with sh, on Windows too
  put(dir, ".gitattributes", "*.py filter=foo\n");
  put(dir, "a.py", F(1));
  const prev = [process.env.HOME, process.env.XDG_CONFIG_HOME];
  process.env.HOME = home;
  try { assert.ok(await snap(dir)); } finally { process.env.HOME = prev[0]; if (prev[1] === undefined) delete process.env.XDG_CONFIG_HOME; }
  assert.ok(!fs.existsSync(marker));
}));
