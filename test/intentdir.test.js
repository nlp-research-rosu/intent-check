import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeUnit, unitDir, ensureScaffold, appendSentLog } from "../lib/intentdir.js";
import { tmpdir, makeRepo, ROOT } from "./helpers/env.js";

const example = JSON.parse(fs.readFileSync(path.join(ROOT, "contract", "examples", "status-done-concerns.json"), "utf8"));

test("writes one unit folder with the four artifacts and meta.json", () => {
  const root = tmpdir();
  const unit = { ...example.result.units[0], path: "src/billing/pricing.py" };
  assert.equal(writeUnit(root, unit, { job_id: example.job_id, url: example.url }, example.result), true);
  const dir = path.join(root, ".intent", "src", "billing", "pricing.py");
  for (const f of ["INTENT.md", "SPEC.k", "SEMANTICS.k", "VERDICT.md"]) {
    assert.equal(fs.readFileSync(path.join(dir, f), "utf8"), unit.artifacts[f]);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  assert.equal(meta.source_sha256, unit.checked_sha256);
  assert.equal(meta.review_id, example.job_id);
  assert.equal(meta.url, example.url);
  assert.equal(meta.verdict, "concerns");
  assert.equal(meta.reviewed_at, example.result.checked_at);
  assert.ok(meta.versions.plugin);
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("scaffold: README, .ignore with *, .gitignore for the local log and queue", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const d = path.join(root, ".intent");
  assert.equal(fs.readFileSync(path.join(d, ".ignore"), "utf8"), "*\n");
  assert.equal(fs.readFileSync(path.join(d, ".gitignore"), "utf8"), ".sent.log\n.queue\n");
  const readme = fs.readFileSync(path.join(d, "README.md"), "utf8");
  assert.match(readme, /\.intent\/\n/);
  assert.doesNotMatch(readme, /\b(verified|proved|proven|compiles)\b/i);
});

test("git tracks .intent/ but not the sent log", () => {
  const { dir, git } = makeRepo();
  writeUnit(dir, example.result.units[0], { job_id: example.job_id, url: example.url }, example.result);
  appendSentLog(dir, { time: "t", url: "u", paths: ["pricing.py"], bytes: 1 });
  const out = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir }).toString();
  assert.match(out, /\.intent\/pricing\.py\/SPEC\.k/);
  assert.match(out, /\.intent\/README\.md/);
  assert.doesNotMatch(out, /\.sent\.log/);
  void git;
});

test("ripgrep-style .ignore hides the folder from search tools", { skip: !hasRg() }, () => {
  const { dir } = makeRepo();
  writeUnit(dir, example.result.units[0], { job_id: example.job_id, url: example.url }, example.result);
  fs.writeFileSync(path.join(dir, "pricing.py"), "def apply_discount(): pass\n");
  const out = execFileSync("rg", ["-l", "apply_discount", "."], { cwd: dir }).toString();
  assert.equal(out.trim().replace(/^\.\//, ""), "pricing.py");
});

function hasRg() {
  try { execFileSync("rg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("unit paths that could escape .intent/ are refused", () => {
  const root = tmpdir();
  for (const p of ["../x.py", "/etc/passwd", "a/../../x.py", "C:/x.py", ".intent/x.py", ".git/config", "a//b.py", "", "a\nb.py"]) {
    assert.equal(unitDir(root, p), null, p);
    assert.equal(writeUnit(root, { ...example.result.units[0], path: p }, { job_id: "j", url: "u" }, example.result), false, p);
  }
  assert.equal(fs.existsSync(path.join(root, "..", "x.py")), false);
});

test("sent log holds paths and sizes, never contents", () => {
  const root = tmpdir();
  appendSentLog(root, { time: "2026-09-28T14:00:00Z", url: "https://x/v1/jobs", paths: ["pricing.py"], bytes: 981, redactions: 0 });
  const line = JSON.parse(fs.readFileSync(path.join(root, ".intent", ".sent.log"), "utf8").trim());
  assert.deepEqual(Object.keys(line).sort(), ["bytes", "paths", "redactions", "time", "url"]);
});

test("a symlink planted in .intent/ cannot redirect writes outside it", () => {
  const root = tmpdir();
  const outside = tmpdir("intent-outside-");
  fs.mkdirSync(path.join(root, ".intent"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, ".intent", "src"));
  const ok = writeUnit(root, { ...example.result.units[0], path: "src/pricing.py" }, { job_id: "j", url: "u" }, example.result);
  assert.equal(ok, false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a late result for a deleted repo does not recreate it", () => {
  const root = path.join(tmpdir(), "gone");
  assert.equal(writeUnit(root, example.result.units[0], { job_id: "j", url: "u" }, example.result), false);
  assert.equal(fs.existsSync(root), false);
});

test("a .intent symlink is refused", () => {
  const root = tmpdir();
  const outside = tmpdir("intent-outside-");
  fs.symlinkSync(outside, path.join(root, ".intent"));
  assert.throws(() => writeUnit(root, example.result.units[0], { job_id: "j", url: "u" }, example.result));
  appendSentLog(root, { time: "t" });
  assert.deepEqual(fs.readdirSync(outside), []);
});
