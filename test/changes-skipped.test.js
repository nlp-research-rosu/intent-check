// collectChanges' skipped-files tracking (T1): files the filter excludes, but that changed
// enough lines to be worth explaining to the user. Uses the touched-only (no baseline) path,
// since the baseline/git-diff scan is already covered end to end in runner.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectChanges } from "../lib/changes.js";
import { makeRepo } from "./helpers/env.js";

function write(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

async function collect(repo, rel, content) {
  const abs = write(repo, rel, content);
  return collectChanges({ touched: [abs], patches: {}, baseline: null }, repo);
}

test("a styling file that changed enough lines is reported skipped, reason 'styling or markup'", async () => {
  const { dir: repo } = makeRepo();
  const ch = await collect(repo, "styles.css", lines(10));
  assert.equal(ch.files.length, 0);
  assert.deepEqual(ch.skipped, [{ rel: "styles.css", reason: "styling or markup" }]);
});

test("a test file is reported skipped, reason 'test'", async () => {
  const { dir: repo } = makeRepo();
  const ch = await collect(repo, "tests/foo.test.js", lines(10));
  assert.equal(ch.files.length, 0);
  assert.deepEqual(ch.skipped, [{ rel: "tests/foo.test.js", reason: "test" }]);
});

test("a config file is reported skipped, reason 'config'", async () => {
  const { dir: repo } = makeRepo();
  const ch = await collect(repo, "jest.config.js", lines(10));
  assert.equal(ch.files.length, 0);
  assert.deepEqual(ch.skipped, [{ rel: "jest.config.js", reason: "config" }]);
});

test("a vendored file is reported skipped, reason 'vendor'", async () => {
  const { dir: repo } = makeRepo();
  const ch = await collect(repo, "vendor/lib.go", lines(10));
  assert.equal(ch.files.length, 0);
  assert.deepEqual(ch.skipped, [{ rel: "vendor/lib.go", reason: "vendor" }]);
});

test("below the 3-changed-lines threshold, a skipped file is not reported at all", async () => {
  const { dir: repo } = makeRepo();
  const ch = await collect(repo, "styles.css", "a\n");
  assert.equal(ch.files.length, 0);
  assert.deepEqual(ch.skipped, []);
});

test("a real code file is checked, not reported as skipped", async () => {
  const { dir: repo } = makeRepo();
  const ch = await collect(repo, "app.py", lines(10));
  assert.equal(ch.skipped.length, 0);
  assert.equal(ch.files.length, 1);
  assert.equal(ch.files[0].rel, "app.py");
});

test("a secret-like file is never read or reported, even if skipped", async () => {
  const { dir: repo } = makeRepo();
  const ch = await collect(repo, ".env", lines(10));
  assert.equal(ch.files.length, 0);
  assert.deepEqual(ch.skipped, []);
});
