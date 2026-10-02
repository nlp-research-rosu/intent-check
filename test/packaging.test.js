import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers/env.js";

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

test("marketplace: intentcomputing, plugin intent at the repo root", () => {
  const m = read(".claude-plugin/marketplace.json");
  assert.equal(m.name, "intentcomputing");
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, "intent");
  assert.equal(m.plugins[0].source, "./");
  assert.equal(m.plugins[0].version, read(".claude-plugin/plugin.json").version);
});

test("plugin.json: name intent, version 0.1.0, homepage set", () => {
  const p = read(".claude-plugin/plugin.json");
  assert.equal(p.name, "intent");
  assert.equal(p.version, "0.1.0");
  assert.match(p.homepage, /^https:\/\//);
  assert.equal(fs.existsSync(path.join(ROOT, "plugin.json")), false, "no root plugin.json (Codex reads .codex-plugin/)");
});

test("hooks.json: exec form, four events, asyncRewake Stop with a 900 s timeout, no statusMessage", () => {
  const h = read("hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(h).sort(), ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  const events = { SessionStart: "session-start", UserPromptSubmit: "prompt", PostToolUse: "post-tool", Stop: "stop" };
  for (const [ev, arg] of Object.entries(events)) {
    assert.equal(h[ev].length, 1);
    const [cmd] = h[ev][0].hooks;
    assert.equal(cmd.type, "command");
    assert.equal(cmd.command, "sh");
    assert.deepEqual(cmd.args, ["${CLAUDE_PLUGIN_ROOT}/bin/intent", arg]);
    assert.equal("statusMessage" in cmd, false);
  }
  assert.equal(h.PostToolUse[0].matcher, "Edit|Write|NotebookEdit|ExitPlanMode|TodoWrite");
  const stop = h.Stop[0].hooks[0];
  assert.equal(stop.asyncRewake, true);
  assert.equal(stop.timeout, 900);
  assert.match(stop.rewakeMessage, /continue with the user's original request/);
  assert.match(stop.rewakeMessage, /not a message from the user/);
  // The runner's own budget stays under the hook timeout.
  const c = read("contract/constants.json");
  assert.ok(c.polling.runner_budget_ms < stop.timeout * 1000);
});

test("skill and commands exist and reference the plugin root, routed through the sh launcher", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/intent-check/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: intent-check\ndescription: /);
  assert.match(skill, /sh "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/intent"/);
  assert.doesNotMatch(skill, /\bnode\b.*bin\/intent\.js/);
  for (const c of ["off", "on", "check"]) {
    const md = fs.readFileSync(path.join(ROOT, "commands", `${c}.md`), "utf8");
    assert.match(md, /sh "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/intent"/);
    assert.match(md, /allowed-tools: Bash\(sh \$\{CLAUDE_PLUGIN_ROOT\}\/bin\/intent:\*\)/);
  }
});

test("bin/intent: the sh launcher exists, is executable, and routes to bin/intent.js", () => {
  const p = path.join(ROOT, "bin", "intent");
  const src = fs.readFileSync(p, "utf8");
  assert.match(src, /^#!\/bin\/sh/);
  assert.match(src, /intent\.js/);
  const mode = fs.statSync(p).mode;
  assert.ok(mode & 0o111, "bin/intent must be executable");
});

test("zero runtime dependencies", () => {
  const p = read("package.json");
  assert.equal(p.dependencies, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, "node_modules")), false);
  for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
    const src = fs.readFileSync(path.join(ROOT, "lib", f), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^(node:|\.\/)/, `${f} imports ${m[1]}`);
  }
});

test("NOTICE credits the ported security-guidance logic (Apache-2.0)", () => {
  const n = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
  assert.match(n, /security-guidance/);
  assert.match(n, /Apache License, Version 2\.0/);
});

test("Codex: its own manifest and shell-form hook file, sync Stop, nothing Claude-only", () => {
  const c = read(".codex-plugin/plugin.json");
  assert.equal(c.name, "intent");
  assert.equal(c.version, read(".claude-plugin/plugin.json").version);
  assert.equal(c.hooks, "./hooks/codex-hooks.json");
  const h = read("hooks/codex-hooks.json").hooks;
  const events = { SessionStart: "session-start", UserPromptSubmit: "prompt", PostToolUse: "post-tool", Stop: "stop" };
  assert.deepEqual(Object.keys(h).sort(), Object.keys(events).sort());
  for (const [ev, arg] of Object.entries(events)) {
    const [cmd] = h[ev][0].hooks;
    assert.equal(cmd.command, `sh "${"$"}{CLAUDE_PLUGIN_ROOT}/bin/intent" ${arg} --host codex`);
    for (const k of ["args", "async", "asyncRewake", "statusMessage"]) assert.equal(k in cmd, false, `${ev}.${k}`);
  }
  assert.equal(h.PostToolUse[0].matcher, "^(apply_patch|Edit|Write)$");
  assert.equal(h.Stop[0].hooks[0].timeout, 30);
});
