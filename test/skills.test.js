import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers/env.js";

const SKILLS = path.join(ROOT, "skills");
const dirs = fs.readdirSync(SKILLS).filter((d) => fs.statSync(path.join(SKILLS, d)).isDirectory());
const mdFiles = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => path.join(d, f));

test("skills: every SKILL.md has a name equal to its folder and a one-line description; none is called prove", () => {
  assert.equal(dirs.includes("prove"), false, "/intent:prove is a command; a skill of that name would clash");
  for (const d of dirs) {
    const src = fs.readFileSync(path.join(SKILLS, d, "SKILL.md"), "utf8");
    const m = src.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, `${d}: front matter`);
    assert.equal((m[1].match(/^name: (.+)$/m) || [])[1], d, `${d}: name`);
    const desc = (m[1].match(/^description: (.+)$/m) || [])[1];
    assert.ok(desc && desc.length <= 1024, `${d}: description`);
  }
});

test("skills: KIT skills are scoped to formal proofs with K and leave review to intent-check", () => {
  for (const d of dirs.filter((d) => d !== "intent-check" && d !== "shared")) {
    const desc = fs.readFileSync(path.join(SKILLS, d, "SKILL.md"), "utf8").match(/^description: (.+)$/m)[1];
    assert.match(desc, /formal proofs? with K|formal-proof \(K\)/, d);
  }
});

test("skills: no prover-client left, and relative markdown links resolve", () => {
  for (const f of mdFiles(SKILLS)) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /prover-client|install-intent-check/, f);
    for (const m of src.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|#|mailto:)/.test(m[1])) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), m[1].split("#")[0])), `${path.relative(ROOT, f)}: ${m[1]}`);
    }
  }
});

// The doctrine suite is Python (unittest); it is skipped where no Python is installed.
test("skills: proof-extension doctrine contract", (t) => {
  const script = path.join(ROOT, "test", "skills", "proof-extension-contract.py");
  for (const py of ["python3", "python"]) {
    const r = spawnSync(py, ["-I", script], { encoding: "utf8" });
    if (r.error) continue;
    assert.equal(r.status, 0, r.stderr);
    return;
  }
  t.skip("python is not installed");
});
