// Schema test for docs/install.json, the single source of truth for install steps
// (the prover's homepage vendors a copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers/env.js";

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "install.json"), "utf8"));
const ALLOWED = new Set(["marketplace", "ref", "codex_ref"]);
const TOOLS = ["claude-code", "codex"];
const INTERFACES = ["desktop", "cli", "vscode"];
const OSES = ["macos", "windows", "linux"];
const expected = TOOLS.flatMap((t) =>
  INTERFACES.flatMap((i) => OSES.filter((o) => !(i === "desktop" && o === "linux")).map((o) => [t, i, o])),
);
const nonEmpty = (s) => typeof s === "string" && s.trim() !== "";
const isNote = (c) => c.note !== undefined;

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
});

test("install.json: full cells have steps, prereqs, verify and update; note cells point at a full cell", () => {
  for (const [t, i, o] of expected) {
    const c = data.cells[t][i][o];
    const at = `${t}/${i}/${o}`;
    if (isNote(c)) {
      assert.ok(nonEmpty(c.note), `${at}: note`);
      assert.equal(c.steps, undefined, `${at}: a note cell has no steps`);
      const target = data.cells[c.see?.tool]?.[c.see?.interface]?.[o];
      assert.ok(target && !isNote(target), `${at}: see must name a full cell for the same OS`);
      continue;
    }
    assert.ok(Array.isArray(c.steps) && c.steps.length > 0, `${at}: steps`);
    assert.ok(c.steps.every(nonEmpty), `${at}: empty step`);
    assert.ok(Array.isArray(c.prereqs) && c.prereqs.length > 0 && c.prereqs.every(nonEmpty), `${at}: prereqs`);
    assert.ok(nonEmpty(c.verify), `${at}: verify`);
    assert.ok(nonEmpty(c.update), `${at}: update`);
  }
});

test("install.json: no cell is unverified and the terminal flag is gone", () => {
  for (const [t, i, o] of expected) {
    const c = data.cells[t][i][o];
    assert.ok(!("unverified" in c) && !("unverified_reason" in c), `${t}/${i}/${o}: unverified cells must not ship`);
    assert.ok(!("no_terminal" in c), `${t}/${i}/${o}: no_terminal was removed`);
  }
  assert.doesNotMatch(JSON.stringify(data.cells), /on PATH/, "user-facing text does not say 'on PATH'");
});

test("install.json: placeholders come only from the allowed set; Codex steps use {codex_ref}, Claude steps {ref}", () => {
  for (const [t, i, o] of expected) {
    const c = data.cells[t][i][o];
    const text = JSON.stringify(c);
    for (const m of text.matchAll(/\{([^{}"\\]*)\}/g)) assert.ok(ALLOWED.has(m[1]), `${t}/${i}/${o}: unknown placeholder {${m[1]}}`);
    if (isNote(c)) continue;
    assert.ok(c.steps.some((s) => s.includes("{marketplace}")), `${t}/${i}/${o}: no step uses {marketplace}`);
    assert.equal(c.steps.join(" ").includes("{ref}"), t === "claude-code", `${t}/${i}/${o}: {ref} is for Claude steps only`);
    assert.equal(c.steps.join(" ").includes("{codex_ref}"), t === "codex", `${t}/${i}/${o}: {codex_ref} is for Codex steps only`);
  }
});

test("README links to docs/install.json", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"), /\]\(docs\/install\.json\)/);
});

test("install.json: every Windows cell uses npx.cmd, never bare npx (PowerShell blocks npx.ps1)", () => {
  for (const t of TOOLS) for (const i of INTERFACES) {
    const c = data.cells[t]?.[i]?.windows;
    if (!c) continue;
    assert.doesNotMatch(JSON.stringify(c), /\bnpx(?!\.cmd)\b/, `${t}/${i}/windows: use npx.cmd`);
  }
  assert.match(JSON.stringify(data.cells["claude-code"].vscode.windows), /npx\.cmd -y @anthropic-ai\/claude-code@latest/);
});

test("install.json: desktop prereqs name the right shell per OS and drop the Mac quit-and-reopen note", () => {
  const mac = data.cells["claude-code"].desktop.macos.prereqs.join(" ");
  const win = data.cells["claude-code"].desktop.windows.prereqs.join(" ");
  assert.match(mac, /in Terminal\./); assert.doesNotMatch(mac, /PowerShell/);
  assert.match(win, /in PowerShell\./); assert.doesNotMatch(win, /Terminal/);
  assert.doesNotMatch(JSON.stringify(data.cells), /quit and reopen/);
});
