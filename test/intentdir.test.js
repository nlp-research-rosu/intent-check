import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureScaffold, appendSentLog, insideIntent, README } from "../lib/intentdir.js";
import { symlink, tmpdir, makeRepo } from "./helpers/env.js";

test("scaffold: README, .ignore with *, .gitignore for the local log and queue", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const d = path.join(root, ".intent");
  assert.equal(fs.readFileSync(path.join(d, ".ignore"), "utf8"), "*\n");
  assert.equal(fs.readFileSync(path.join(d, ".gitignore"), "utf8"), ".sent.log\n.queue\n.storage.lock\n");
  const readme = fs.readFileSync(path.join(d, "README.md"), "utf8");
  assert.match(readme, /Commit this folder with the source/);
  assert.doesNotMatch(readme, /\b(verified|proved|proven|compiles)\b/i);
});

test("git tracks .intent/ but not the sent log", () => {
  const { dir, git } = makeRepo();
  ensureScaffold(dir);
  fs.mkdirSync(path.join(dir, ".intent", "deepscan", "task"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".intent", "deepscan", "task", "report.json"), "{}\n");
  appendSentLog(dir, { time: "t", url: "u", paths: ["pricing.py"], bytes: 1 });
  const out = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir }).toString();
  assert.match(out, /\.intent\/deepscan\/task\/report\.json/);
  assert.match(out, /\.intent\/README\.md/);
  assert.doesNotMatch(out, /\.sent\.log/);
  void git;
});

test("ripgrep-style .ignore hides the folder from search tools", { skip: !hasRg() }, () => {
  const { dir } = makeRepo();
  ensureScaffold(dir);
  fs.writeFileSync(path.join(dir, ".intent", "NOTES.md"), "apply_discount must preserve nonnegative prices.\n");
  fs.writeFileSync(path.join(dir, "pricing.py"), "def apply_discount(): pass\n");
  const out = execFileSync("rg", ["-l", "apply_discount", "."], { cwd: dir }).toString();
  assert.equal(out.trim().replace(/^\.\//, ""), "pricing.py");
});

function hasRg() {
  try { execFileSync("rg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("sent log holds paths and sizes, never contents", () => {
  const root = tmpdir();
  appendSentLog(root, { time: "2026-09-28T14:00:00Z", url: "https://x/tasks/task-id", paths: ["pricing.py"], bytes: 981, redactions: 0 });
  const line = JSON.parse(fs.readFileSync(path.join(root, ".intent", ".sent.log"), "utf8").trim());
  assert.deepEqual(Object.keys(line).sort(), ["bytes", "paths", "redactions", "time", "url"]);
});

test("a symlink planted in .intent/ cannot redirect writes outside it", () => {
  const root = tmpdir();
  const outside = tmpdir("intent-outside-");
  fs.mkdirSync(path.join(root, ".intent"), { recursive: true });
  symlink(outside, path.join(root, ".intent", "src"));
  assert.equal(insideIntent(root, path.join(root, ".intent", "src", "task")), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("README mentions the NOTES.md exception", () => {
  assert.match(README, /NOTES\.md.*confirmed intended behaviour/);
  assert.match(README, /included in later scans/);
});

test("README describes Scan reports and proof inputs", () => {
  assert.match(README, /report\.json/);
  assert.match(README, /prove\/<target>/);
  assert.match(README, /meta\.json/);
  assert.doesNotMatch(README, /SEMANTICS\.k/);
  assert.doesNotMatch(README, /\b(verified|proved|proven|compiles)\b/i);
});

test("scaffold never creates NOTES.md", () => {
  const root = tmpdir();
  ensureScaffold(root);
  assert.equal(fs.existsSync(path.join(root, ".intent", "NOTES.md")), false);
});

test("README is written when missing and existing text is left untouched", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const f = path.join(root, ".intent", "README.md");
  assert.equal(fs.readFileSync(f, "utf8"), README);

  // Already current: re-scaffolding does not rewrite it (mtime untouched).
  const before = fs.statSync(f).mtimeMs;
  ensureScaffold(root);
  assert.equal(fs.statSync(f).mtimeMs, before);

  const headerPlusUserText = "# .intent\n\nAn older version of this file.\n\n## Our team's rule\n\nAlways re-run the checks locally first.\n";
  fs.writeFileSync(f, headerPlusUserText);
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), headerPlusUserText);

  fs.writeFileSync(f, "# My notes about .intent\n\nDo not touch this.\n");
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), "# My notes about .intent\n\nDo not touch this.\n");
});

test("a .intent symlink is refused", () => {
  const root = tmpdir();
  const outside = tmpdir("intent-outside-");
  symlink(outside, path.join(root, ".intent"));
  assert.throws(() => ensureScaffold(root));
  appendSentLog(root, { time: "t" });
  assert.deepEqual(fs.readdirSync(outside), []);
});
