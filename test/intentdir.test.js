import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeUnit, unitDir, ensureScaffold, appendSentLog, README } from "../lib/intentdir.js";
import { runDir } from "../lib/store.js";
import { symlink, tmpdir, makeRepo, ROOT } from "./helpers/env.js";

const example = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "api", "examples", "status-done-concerns.json"), "utf8"));
// REASONING.md + VERIFICATION.k, SEMANTICS.k as the stub (contract 2026-10-01).
const stubExample = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "api", "examples", "status-done-no-concerns.json"), "utf8"));

test("writes one unit folder with the four artifacts and meta.json", () => {
  const root = tmpdir();
  const unit = { ...example.result.units[0], path: "src/billing/pricing.py" };
  assert.equal(writeUnit(root, unit, { job_id: example.job_id, url: example.url }, example.result), true);
  const dir = path.join(runDir(root, example.job_id), "artifacts", unit.path);
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

test("writes VERIFICATION.k and REASONING.md, and skips the SEMANTICS.k stub", () => {
  const root = tmpdir();
  const unit = { ...stubExample.result.units[0], path: "pricing.py" };
  assert.equal(writeUnit(root, unit, { job_id: stubExample.job_id, url: stubExample.url }, stubExample.result), true);
  const dir = path.join(runDir(root, stubExample.job_id), "artifacts", unit.path);
  assert.equal(fs.readFileSync(path.join(dir, "VERIFICATION.k"), "utf8"), unit.artifacts["VERIFICATION.k"]);
  assert.equal(fs.readFileSync(path.join(dir, "REASONING.md"), "utf8"), unit.artifacts["REASONING.md"]);
  // The stub ("// Not generated; see REASONING.md") carries no behaviour, so it is not written.
  assert.equal(fs.existsSync(path.join(dir, "SEMANTICS.k")), false);
});

test("a later stub never inherits SEMANTICS.k from the retained older generation", () => {
  const root = tmpdir();
  const rel = "pricing.py";
  // First check: the old shape, a real SEMANTICS.k gets written.
  writeUnit(root, { ...example.result.units[0], path: rel }, { job_id: example.job_id, url: example.url }, example.result);
  const old = path.join(runDir(root, example.job_id), "artifacts", rel);
  const dir = path.join(runDir(root, "later"), "artifacts", rel);
  assert.equal(fs.existsSync(path.join(old, "SEMANTICS.k")), true);
  // The later generation has its own artifacts and does not inherit the older model.
  writeUnit(root, { ...stubExample.result.units[0], path: rel }, { job_id: "later", url: stubExample.url }, stubExample.result);
  assert.equal(fs.existsSync(path.join(dir, "SEMANTICS.k")), false);
  assert.equal(fs.existsSync(path.join(dir, "VERIFICATION.k")), true);
  assert.equal(fs.existsSync(path.join(dir, "REASONING.md")), true);
  assert.equal(fs.existsSync(path.join(old, "SEMANTICS.k")), true);
});

test("scaffold: README, .ignore with *, .gitignore for the local log and queue", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const d = path.join(root, ".intent");
  assert.equal(fs.readFileSync(path.join(d, ".ignore"), "utf8"), "*\n");
  assert.equal(fs.readFileSync(path.join(d, ".gitignore"), "utf8"), ".sent.log\n.queue\n.storage.lock\n");
  assert.equal(fs.existsSync(path.join(d, "README.md")), true);
});

test("git tracks .intent/ but not the sent log", () => {
  const { dir, git } = makeRepo();
  writeUnit(dir, example.result.units[0], { job_id: example.job_id, url: example.url }, example.result);
  appendSentLog(dir, { time: "t", url: "u", paths: ["pricing.py"], bytes: 1 });
  const out = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir }).toString();
  assert.match(out, /\.intent\/logs\/[a-z0-9]{6}\/artifacts\/pricing\.py\/SPEC\.k/);
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
  appendSentLog(root, { time: "2026-09-28T14:00:00Z", url: "https://x/intent-checks", paths: ["pricing.py"], bytes: 981, redactions: 0 });
  const line = JSON.parse(fs.readFileSync(path.join(root, ".intent", ".sent.log"), "utf8").trim());
  assert.deepEqual(Object.keys(line).sort(), ["bytes", "paths", "redactions", "time", "url"]);
});

test("a symlink planted in .intent/ cannot redirect writes outside it", () => {
  const root = tmpdir();
  const outside = tmpdir("intent-outside-");
  const dir = path.join(runDir(root, "j"), "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  symlink(outside, path.join(dir, "src"));
  const ok = writeUnit(root, { ...example.result.units[0], path: "src/pricing.py" }, { job_id: "j", url: "u" }, example.result);
  assert.equal(ok, false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a late result for a deleted repo does not recreate it", () => {
  const root = path.join(tmpdir(), "gone");
  assert.equal(writeUnit(root, example.result.units[0], { job_id: "j", url: "u" }, example.result), false);
  assert.equal(fs.existsSync(root), false);
});

// Existing README contents remain untouched; scaffolding performs no migration.
const PAST_README_WITH_NOTES = `# .intent

This folder is written by Intent Check (the \`intent\` plugin for Claude Code and Codex).
Each source file that was checked has a folder here, named by its path from the repo root:

- \`INTENT.md\`: the intent of the code, with its assumptions made explicit
- \`SPEC.k\`: K claims about the code
- \`SEMANTICS.k\`: the code's behaviour as K rewrite rules
- \`VERDICT.md\`: the verdict and any concerns
- \`meta.json\`: the file hash that was checked, when, and the report link

Do not edit these files by hand; the next check of a file updates its folder.

\`NOTES.md\` is yours: one bullet per behaviour you have confirmed is intended. It is sent with every check and those behaviours are not raised again. Everything else here is written by Intent Check.

\`.sent.log\` lists every upload from this repo (paths, sizes, time, where to). It never holds file contents and is not committed.

## Not committing this folder

The folder is meant to be committed. To keep it out of git, add this line to your repo's \`.gitignore\`:

    .intent/

To stop checks altogether, run \`/intent:off\` (or set \`INTENT_DISABLED=1\` or \`DO_NOT_TRACK=1\`).
`;

test("scaffolding does not migrate an existing NOTES.md-era README", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const f = path.join(root, ".intent", "README.md");
  fs.writeFileSync(f, PAST_README_WITH_NOTES);
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), PAST_README_WITH_NOTES);
});

test("scaffold never creates NOTES.md", () => {
  const root = tmpdir();
  ensureScaffold(root);
  assert.equal(fs.existsSync(path.join(root, ".intent", "NOTES.md")), false);
});

// The exact README text this file shipped before the NOTES.md exception was added (see git
// history: lib/intentdir.js as of commit a3c1404). Refresh only recognises byte-exact matches.
const PAST_README = `# .intent

This folder is written by Intent Check (the \`intent\` plugin for Claude Code and Codex).
Each source file that was checked has a folder here, named by its path from the repo root:

- \`INTENT.md\`: the intent of the code, with its assumptions made explicit
- \`SPEC.k\`: K claims about the code
- \`SEMANTICS.k\`: the code's behaviour as K rewrite rules
- \`VERDICT.md\`: the verdict and any concerns
- \`meta.json\`: the file hash that was checked, when, and the report link

Do not edit these files by hand; the next check of a file updates its folder.

\`.sent.log\` lists every upload from this repo (paths, sizes, time, where to). It never holds file contents and is not committed.

## Not committing this folder

The folder is meant to be committed. To keep it out of git, add this line to your repo's \`.gitignore\`:

    .intent/

To stop checks altogether, run \`/intent:off\` (or set \`INTENT_DISABLED=1\` or \`DO_NOT_TRACK=1\`).
`;

test("README is written when missing and never overwrites existing content", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const f = path.join(root, ".intent", "README.md");
  assert.equal(fs.readFileSync(f, "utf8"), README);

  // Already current: re-scaffolding does not rewrite it (mtime untouched).
  const before = fs.statSync(f).mtimeMs;
  ensureScaffold(root);
  assert.equal(fs.statSync(f).mtimeMs, before);

  // Even a byte-exact past version is not migrated.
  fs.writeFileSync(f, PAST_README);
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), PAST_README);

  // Our header, but with user text appended below it (not a byte-exact past version): never
  // overwritten, even though it "starts with" our header.
  const headerPlusUserText = "# .intent\n\nAn older version of this file.\n\n## Our team's rule\n\nAlways re-run the checks locally first.\n";
  fs.writeFileSync(f, headerPlusUserText);
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), headerPlusUserText);

  // User-modified, no relation to our header: never overwritten.
  fs.writeFileSync(f, "# My notes about .intent\n\nDo not touch this.\n");
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), "# My notes about .intent\n\nDo not touch this.\n");
});

test("writing a source review never touches the project brief or requirements", () => {
  const root = tmpdir();
  ensureScaffold(root);
  fs.writeFileSync(path.join(root, ".intent", "REQUIREMENTS.md"), "- Kept on purpose.\n");
  fs.writeFileSync(path.join(root, ".intent", "requirements.json"), '{"version":1,"requirements":[]}');
  writeUnit(root, example.result.units[0], { job_id: "j", url: "u" }, example.result);
  assert.equal(fs.readFileSync(path.join(root, ".intent", "REQUIREMENTS.md"), "utf8"), "- Kept on purpose.\n");
  assert.equal(fs.readFileSync(path.join(root, ".intent", "requirements.json"), "utf8"), '{"version":1,"requirements":[]}');
});

test("a .intent symlink is refused", () => {
  const root = tmpdir();
  const outside = tmpdir("intent-outside-");
  symlink(outside, path.join(root, ".intent"));
  assert.throws(() => writeUnit(root, example.result.units[0], { job_id: "j", url: "u" }, example.result));
  appendSentLog(root, { time: "t" });
  assert.deepEqual(fs.readdirSync(outside), []);
});
