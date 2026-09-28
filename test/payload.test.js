import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildRequest, unitContent, idempotencyKey, readPrior } from "../lib/payload.js";
import { countChangedLines, hunkRanges, newFileDiff, patchesToDiff } from "../lib/changes.js";
import { writeUnit } from "../lib/intentdir.js";
import { validateDef } from "./helpers/schema.js";
import { tmpdir, ROOT } from "./helpers/env.js";

const snap = {
  prompts: ["Add a helper that applies a percentage discount. It should never go below zero.", "also use key sk-proj-" + "Zq8".repeat(14)],
  first_prompt: "Build me a pricing module for the shop",
  plan: "1. Add apply_discount",
  todos: ["Add apply_discount", "Clamp at zero"],
};
const stop = { permission_mode: "acceptEdits", last_assistant_message: "Added apply_discount. It handles all the edge cases." };

function file(rel, content, diff) {
  const d = diff === undefined ? newFileDiff(rel, content) : diff;
  return { rel, abs: "/x/" + rel, buf: Buffer.from(content), content, diff: d, changed: countChangedLines(d) };
}

test("builds a contract-valid edit JobRequest", () => {
  const f = file("pricing.py", "# pricing.py\ndef apply_discount(price_cents: int, percent: int) -> int:\n    return price_cents - price_cents * percent // 100\n");
  const b = buildRequest({ files: [f], root: tmpdir(), snap, stop, sessionHash: "e43a48a0bbd65fcbe24d5a8b665b86a3", turnId: "turn-3", host: "claude-code", hostVersion: "2.1.283" });
  assert.deepEqual(validateDef(b.request, "JobRequest"), []);
  assert.equal(b.request.mode, "edit");
  assert.equal(b.request.changed_lines, 3);
  assert.equal(b.request.units[0].sha256, "a949e6048d964c91f2a1587532adda76e4348d987f3c78cdf6c47f5b7b94a510");
  assert.equal(b.request.intent.first_prompt, snap.first_prompt);
  assert.equal(b.request.intent.agent_message, stop.last_assistant_message);
  // Secrets in prompts are redacted before sending.
  assert.ok(!JSON.stringify(b.request).includes("Zq8Zq8Zq8"));
  assert.equal(b.redactions, 1);
});

test("skips turns with fewer than 3 changed lines", () => {
  const f = file("a.py", "x = 1\ny = 2\n");
  assert.equal(buildRequest({ files: [f], root: tmpdir(), snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" }), null);
});

test("caps units at 10 and changed lines at 1,500, dropping later files", () => {
  const many = Array.from({ length: 12 }, (_, i) => file(`m${i}.py`, "a\nb\nc\n"));
  const b = buildRequest({ files: many, root: tmpdir(), snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.equal(b.request.units.length, 10);
  assert.equal(b.request.truncated, true);
  const big = file("big.py", Array.from({ length: 1400 }, (_, i) => `x${i} = ${i}`).join("\n") + "\n");
  const b2 = buildRequest({ files: [big, file("more.py", Array.from({ length: 200 }, () => "y = 1").join("\n") + "\n"), file("c.py", "a\nb\nc\n")], root: tmpdir(), snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.deepEqual(b2.request.units.map((u) => u.path), ["big.py", "c.py"]);
  assert.equal(b2.request.truncated, true);
});

test("large files send only touched regions ±40 lines", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
  const diff = "@@ -100,1 +100,2 @@\n-line 100\n+line 100\n+line 101\n@@ -2500,0 +2501,1 @@\n+line 2501\n";
  const { content, truncated } = unitContent(lines.join("\n"), diff);
  assert.equal(truncated, true);
  const parts = content.split("\n...\n");
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith("line 60\n") && parts[0].endsWith("line 141"));
  assert.ok(parts[1].startsWith("line 2461\n") && parts[1].endsWith("line 2541"));
  assert.deepEqual(hunkRanges(diff), [[100, 101], [2501, 2501]]);
});

test("prior artifacts come from .intent/", () => {
  const root = tmpdir();
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "contract", "examples", "status-done-concerns.json"), "utf8"));
  writeUnit(root, ex.result.units[0], { job_id: ex.job_id, url: ex.url }, ex.result);
  const p = readPrior(root, "pricing.py");
  assert.equal(p.source_sha256, ex.result.units[0].checked_sha256);
  assert.match(p.spec_k, /PRICING-SPEC/);
  assert.equal(readPrior(root, "other.py"), null);
});

test("idempotency key depends on session, turn, paths and file hashes", () => {
  const a = idempotencyKey("s", "t", [{ rel: "a.py", sha256: "1" }]);
  assert.equal(a, idempotencyKey("s", "t", [{ rel: "a.py", sha256: "1" }]));
  assert.notEqual(a, idempotencyKey("s", "t2", [{ rel: "a.py", sha256: "1" }]));
  assert.notEqual(a, idempotencyKey("s", "t", [{ rel: "a.py", sha256: "2" }]));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("structuredPatch hunks become a unified diff", () => {
  const d = patchesToDiff("calc.py", [{ oldStart: 2, oldLines: 4, newStart: 2, newLines: 5, lines: ["     return a + b", " ", " def sub(a, b):", "+    \"\"\"Doc.\"\"\"", "     return a - b"] }]);
  assert.match(d, /^--- a\/calc\.py\n\+\+\+ b\/calc\.py\n@@ -2,4 \+2,5 @@\n/);
  assert.equal(countChangedLines(d), 1);
});
