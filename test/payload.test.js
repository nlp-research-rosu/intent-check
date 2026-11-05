import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildRequest, unitContent, readPrior, readNotes } from "../lib/payload.js";
import { writeUnit } from "../lib/intentdir.js";
import { validateDef } from "./helpers/schema.js";
import { symlink, SKIP_FILE_SYMLINKS, tmpdir, ROOT } from "./helpers/env.js";

const file = (rel, content) => ({ rel, buf: Buffer.from(content), content });
const build = (files, root = tmpdir()) => buildRequest({ files, root, sessionHash: "e43a48a0bbd65fcbe24d5a8b665b86a3", turnId: "explicit-1", host: "claude-code" });

test("explicit file request is contract-valid, with no captured session context", () => {
  const result = build([file("pricing.py", "def f():\n    return 1\n")]);
  assert.deepEqual(validateDef(result.request, "JobRequest"), []);
  assert.equal(result.request.mode, "request");
  assert.deepEqual(result.request.intent, { prompts: [], first_prompt: null, plan: null, todos: [], agent_message: null });
  assert.equal(result.request.units[0].diff, null);
  assert.equal(result.request.permission_mode, null);
});

test("explicit files do not need a minimum number of changed lines; units are capped", () => {
  assert.ok(build([file("a.py", "x = 1\n")]));
  const result = build(Array.from({ length: 12 }, (_, i) => file(`m${i}.py`, "x = 1\n")));
  assert.equal(result.request.units.length, 10);
  assert.equal(result.truncated, true);
});

test("large explicit file content retains the first 1,500 lines", () => {
  const result = unitContent(Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));
  assert.equal(result.truncated, true);
  assert.deepEqual(result.regions, [{ start: 1, end: 1500 }]);
  assert.ok(result.content.endsWith("line 1500"));
});

test("prior artifacts and NOTES are redacted, bounded and contract-valid", () => {
  const root = tmpdir();
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/api/examples/status-done-no-concerns.json"), "utf8"));
  writeUnit(root, example.result.units[0], { job_id: example.job_id, url: example.url }, example.result);
  assert.match(readPrior(root, "pricing.py").verification_k, /PRICING-VERIFICATION/);
  fs.writeFileSync(path.join(root, ".intent", "NOTES.md"), "- Intended behaviour. Key sk-proj-" + "Zq8".repeat(14));
  const result = build([file("pricing.py", "x = 1\n")], root);
  assert.deepEqual(validateDef(result.request, "JobRequest"), []);
  assert.match(result.request.intent.notes, /Intended behaviour/);
  assert.ok(!JSON.stringify(result.request).includes("Zq8Zq8"));
});

test("symlinked NOTES and prior artifacts are not read", { skip: SKIP_FILE_SYMLINKS }, () => {
  const root = tmpdir();
  const secret = path.join(tmpdir(), "secret");
  fs.writeFileSync(secret, "private");
  fs.mkdirSync(path.join(root, ".intent", "a.py"), { recursive: true });
  symlink(secret, path.join(root, ".intent", "NOTES.md"));
  symlink(secret, path.join(root, ".intent", "a.py", "INTENT.md"));
  assert.equal(readNotes(root), null);
  assert.equal(readPrior(root, "a.py"), null);
});
