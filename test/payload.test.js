import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildRequest, unitContent, idempotencyKey, readPrior, readNotes } from "../lib/payload.js";
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
  const { content, truncated, regions } = unitContent(lines.join("\n"), diff);
  assert.equal(truncated, true);
  assert.deepEqual(regions, [{ start: 60, end: 141 }, { start: 2461, end: 2541 }]);
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
  // This fixture predates VERIFICATION.k (old-style unit folder): absent, not an error.
  assert.equal(p.verification_k, null);
  assert.equal(readPrior(root, "other.py"), null);
});

test("prior artifacts: VERIFICATION.k comes back too, redacted and schema-valid, once a unit has one", () => {
  const root = tmpdir();
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "contract", "examples", "status-done-no-concerns.json"), "utf8"));
  writeUnit(root, ex.result.units[0], { job_id: ex.job_id, url: ex.url }, ex.result);
  const p = readPrior(root, "pricing.py");
  assert.match(p.verification_k, /PRICING-VERIFICATION/);
  assert.match(p.verification_k, /floordiv/);

  const f = file("pricing.py", "# pricing.py\ndef apply_discount(price_cents: int, percent: int) -> int:\n    return price_cents - price_cents * percent // 100\n");
  const b = buildRequest({ files: [f], root, snap, stop, sessionHash: "e43a48a0bbd65fcbe24d5a8b665b86a3", turnId: "turn-3", host: "claude-code", hostVersion: "2.1.283" });
  assert.deepEqual(validateDef(b.request, "JobRequest"), []);
  assert.match(b.request.units[0].prior.verification_k, /PRICING-VERIFICATION/);
});

test("intent.notes: read from .intent/NOTES.md, redacted, clipped and schema-valid", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".intent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".intent", "NOTES.md"), "- Coupons intentionally never expire; the docstring is stale. Key sk-proj-" + "Zq8".repeat(14) + "\n");
  const f = file("pricing.py", "# pricing.py\ndef apply_discount(price_cents: int, percent: int) -> int:\n    return price_cents - price_cents * percent // 100\n");
  const b = buildRequest({ files: [f], root, snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.deepEqual(validateDef(b.request, "JobRequest"), []);
  assert.match(b.request.intent.notes, /Coupons intentionally never expire/);
  assert.ok(!b.request.intent.notes.includes("Zq8Zq8Zq8"), "secret redacted");

  const long = tmpdir();
  fs.mkdirSync(path.join(long, ".intent"), { recursive: true });
  fs.writeFileSync(path.join(long, ".intent", "NOTES.md"), "x".repeat(5000));
  const b2 = buildRequest({ files: [f], root: long, snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.equal(b2.request.intent.notes.length, 4000);
  assert.deepEqual(validateDef(b2.request, "JobRequest"), []);
});

test("intent.notes: absent when .intent/NOTES.md is missing or empty", () => {
  const f = file("pricing.py", "a\nb\nc\n");
  const b = buildRequest({ files: [f], root: tmpdir(), snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.equal("notes" in b.request.intent, false);
  assert.equal(readNotes(tmpdir()), null);

  const empty = tmpdir();
  fs.mkdirSync(path.join(empty, ".intent"), { recursive: true });
  fs.writeFileSync(path.join(empty, ".intent", "NOTES.md"), "");
  const b2 = buildRequest({ files: [f], root: empty, snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.equal("notes" in b2.request.intent, false);
});

test("intent.notes: a symlinked NOTES.md is refused", () => {
  const root = tmpdir();
  const outside = tmpdir("intent-outside-");
  fs.writeFileSync(path.join(outside, "secret.md"), "- leaked\n");
  fs.mkdirSync(path.join(root, ".intent"), { recursive: true });
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, ".intent", "NOTES.md"));
  assert.equal(readNotes(root), null);
  const f = file("pricing.py", "a\nb\nc\n");
  const b = buildRequest({ files: [f], root, snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.equal("notes" in b.request.intent, false);
});

test("intent.notes: an oversized NOTES.md (> 64 KB) is refused", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".intent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".intent", "NOTES.md"), "x".repeat(64 * 1024 + 1));
  assert.equal(readNotes(root), null);
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

test("truncated units carry their real line ranges and stay contract-valid", () => {
  const content = Array.from({ length: 2000 }, (_, i) => `v${i} = ${i}`).join("\n") + "\n";
  const diff = "--- a/big.py\n+++ b/big.py\n@@ -1000,1 +1000,1 @@\n-v999 = 0\n+v999 = 999\n@@ -1500,0 +1500,1 @@\n+x = 1\n";
  const f = { rel: "big.py", abs: "/x/big.py", buf: Buffer.from(content), content, diff, changed: countChangedLines(diff) };
  const b = buildRequest({ files: [f], root: tmpdir(), snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  const u = b.request.units[0];
  assert.equal(u.content_truncated, true);
  assert.deepEqual(u.regions, [{ start: 960, end: 1040 }, { start: 1460, end: 1540 }]);
  assert.equal(u.content.split("\n...\n").length, u.regions.length);
  assert.deepEqual(validateDef(b.request, "JobRequest"), []);
  const small = buildRequest({ files: [file("s.py", "a\nb\nc\n")], root: tmpdir(), snap, stop, sessionHash: "s", turnId: "t", host: "claude-code" });
  assert.equal("regions" in small.request.units[0], false);
});

test("regions at the end of the file stay inside the file", () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const check = (content, diff, want) => {
    const r = unitContent(content, diff);
    assert.deepEqual(r.regions, want);
    const n = content.split("\n").length - 1;
    for (const g of r.regions) assert.ok(g.start >= 1 && g.start <= g.end && g.end <= n, JSON.stringify(g));
    const parts = r.content.split("\n...\n");
    r.regions.forEach((g, i) => assert.equal(parts[i].split("\n").length, g.end - g.start + 1));
    assert.ok(!r.content.endsWith("\n"), "no extra empty line from the trailing newline");
  };
  // Edit on the last line.
  check(body(3000), "@@ -2998,1 +2998,3 @@\n+a\n+b\n", [{ start: 2958, end: 3000 }]);
  // Two hunks, the second at EOF.
  check(body(3000), "@@ -100,1 +100,1 @@\n-x\n+y\n@@ -2999,0 +3000,1 @@\n+z\n", [{ start: 60, end: 140 }, { start: 2960, end: 3000 }]);
  // A deletion at the end of the file (zero-length new range).
  check(body(3000), "@@ -3001,2 +3000,0 @@\n-gone\n-gone\n", [{ start: 2960, end: 3000 }]);
  // A stale hunk entirely beyond the end of the file is dropped (falls back to the first 1,500 lines).
  check(body(2000), "@@ -5000,1 +5000,1 @@\n-a\n+b\n", [{ start: 1, end: 1500 }]);
});

test("a file of exactly 1,500 lines is sent whole", () => {
  const content = Array.from({ length: 1500 }, (_, i) => `l${i}`).join("\n") + "\n";
  const r = unitContent(content, "@@ -1,1 +1,1 @@\n-a\n+b\n");
  assert.equal(r.truncated, false);
  assert.equal(r.content, content);
  assert.equal(unitContent(content + "extra\n", "@@ -1,1 +1,1 @@\n-a\n+b\n").truncated, true);
});
