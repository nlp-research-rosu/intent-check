// Schema test for docs/install.json, the single source of truth for install steps
// (the prover's homepage vendors a copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers/env.js";

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "install.json"), "utf8"));
const ALLOWED = new Set(["marketplace", "ref"]);
const TOOLS = ["claude-code", "codex"];
const INTERFACES = ["desktop", "cli", "vscode"];
const OSES = ["macos", "windows", "linux"];
const expected = TOOLS.flatMap((t) =>
  INTERFACES.flatMap((i) => OSES.filter((o) => !(i === "desktop" && o === "linux")).map((o) => [t, i, o])),
);

test("install.json: labels cover every tool, interface and OS", () => {
  assert.deepEqual(Object.keys(data.tools), TOOLS);
  assert.deepEqual(Object.keys(data.interfaces), INTERFACES);
  assert.deepEqual(Object.keys(data.os), OSES);
  assert.equal(data.marketplace, "intentcomputing");
  assert.equal(data.plugin, "intent");
});

test("install.json: version matches the plugin version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(data.version, pkg.version);
});

test("install.json: every cell is present, and nothing else is", () => {
  for (const [t, i, o] of expected) assert.ok(data.cells[t]?.[i]?.[o], `missing cell ${t}/${i}/${o}`);
  const found = Object.entries(data.cells).flatMap(([t, ifs]) =>
    Object.entries(ifs).flatMap(([i, oses]) => Object.keys(oses).map((o) => `${t}/${i}/${o}`)),
  );
  assert.deepEqual(found.sort(), expected.map((e) => e.join("/")).sort());
  assert.equal(data.cells["claude-code"].desktop.linux, undefined);
});

test("install.json: each cell has the required fields", () => {
  for (const [t, i, o] of expected) {
    const c = data.cells[t][i][o];
    const at = `${t}/${i}/${o}`;
    assert.ok(Array.isArray(c.steps) && c.steps.length > 0, `${at}: steps`);
    for (const s of c.steps) assert.ok(typeof s === "string" && s.trim() !== "", `${at}: empty step`);
    assert.ok(Array.isArray(c.prereqs) && c.prereqs.length > 0, `${at}: prereqs`);
    for (const s of c.prereqs) assert.ok(typeof s === "string" && s.trim() !== "", `${at}: empty prereq`);
    assert.ok(typeof c.verify === "string" && c.verify.trim() !== "", `${at}: verify`);
    assert.ok(typeof c.update === "string" && c.update.trim() !== "", `${at}: update`);
    assert.equal(typeof c.no_terminal, "boolean", `${at}: no_terminal`);
    assert.equal(c.no_terminal, i === "desktop", `${at}: no_terminal is true for desktop cells only`);
    if (c.unverified !== undefined) {
      assert.equal(c.unverified, true, `${at}: unverified is true or absent`);
      assert.ok(typeof c.unverified_reason === "string" && c.unverified_reason.trim() !== "", `${at}: unverified_reason`);
    }
  }
});

test("install.json: placeholders come only from the allowed set, and every cell adds the marketplace", () => {
  for (const [t, i, o] of expected) {
    const c = data.cells[t][i][o];
    const text = JSON.stringify([c.steps, c.prereqs, c.verify, c.update, c.unverified_reason ?? ""]);
    for (const m of text.matchAll(/\{([^{}"\\]*)\}/g)) assert.ok(ALLOWED.has(m[1]), `${t}/${i}/${o}: unknown placeholder {${m[1]}}`);
    assert.ok(c.steps.some((s) => s.includes("{marketplace}")), `${t}/${i}/${o}: no step uses {marketplace}`);
  }
});

test("README links to docs/install.json", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"), /\]\(docs\/install\.json\)/);
});
