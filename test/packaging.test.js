import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, isExecutable } from "./helpers/env.js";

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

test("marketplace: intentcomputing, plugin intent at the repo root", () => {
  const m = read(".claude-plugin/marketplace.json");
  assert.equal(m.name, "intentcomputing");
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, "intent");
  assert.equal(m.plugins[0].source, "./");
  assert.equal(m.plugins[0].version, read(".claude-plugin/plugin.json").version);
});

test("version: the same valid semver in all four files", () => {
  const files = ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
  const versions = [...files.map((f) => read(f).version), read(".claude-plugin/marketplace.json").plugins[0].version];
  assert.match(versions[0], /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);
  assert.deepEqual(versions, Array(4).fill(versions[0]));
});

test("plugin.json: name intent, version from package.json, homepage set", () => {
  const p = read(".claude-plugin/plugin.json");
  assert.equal(p.name, "intent");
  assert.equal(p.version, read("package.json").version);
  assert.match(p.homepage, /^https:\/\//);
  assert.equal(fs.existsSync(path.join(ROOT, "plugin.json")), false, "no root plugin.json (Codex reads .codex-plugin/)");
});

test("hooks.json: shell form, four events, asyncRewake Stop with a 900 s timeout, no statusMessage", () => {
  const h = read("hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(h).sort(), ["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  const events = { SessionStart: "session-start", UserPromptSubmit: "prompt", PostToolUse: "post-tool", Stop: "stop" };
  for (const [ev, arg] of Object.entries(events)) {
    assert.equal(h[ev].length, 1);
    const [cmd] = h[ev][0].hooks;
    assert.equal(cmd.type, "command");
    // Exec form with node: no shell involved, so it works where `sh` is not on PATH (Windows).
    assert.equal(cmd.command, "node");
    assert.deepEqual(cmd.args, ["${CLAUDE_PLUGIN_ROOT}/bin/hooks.js", arg]);
    assert.equal("statusMessage" in cmd, false);
  }
  assert.equal(h.PostToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|ExitPlanMode|TodoWrite");
  const stop = h.Stop[0].hooks[0];
  assert.equal(stop.asyncRewake, true);
  assert.equal(stop.timeout, 900);
  assert.match(stop.rewakeMessage, /continue with the user's original request/);
  assert.match(stop.rewakeMessage, /not a message from the user/);
  // The runner's own budget stays under the hook timeout.
  const c = read("lib/constants.json");
  assert.ok(c.polling.runner_budget_ms < stop.timeout * 1000);
});

test("hooks do not register automatic sign-in or connection-wait handlers", () => {
  assert.equal(read("hooks/hooks.json").hooks.Stop.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "hooks/hooks.json"), "utf8"), /connect-wait|connect-start/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "hooks/codex-hooks.json"), "utf8"), /connect-wait/);
});

test("skill and commands exist and reference the plugin root, run with node directly", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/intent-check/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: intent-check\ndescription: /);
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/hooks\.js"/);
  assert.doesNotMatch(skill, /\bsh\b.*bin\/intent\b/);
  for (const w of ["on", "live", "off", "doctor", "deepscan", "prove"]) assert.match(skill, new RegExp(`/intent:${w}\\b`), `skill maps ${w}`);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "commands")).sort(), ["deepscan.md", "doctor.md", "live.md", "off.md", "on.md", "prove.md"]);
  for (const c of ["off", "on", "live", "deepscan", "doctor"]) {
    const md = fs.readFileSync(path.join(ROOT, "commands", `${c}.md`), "utf8");
    assert.match(md, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/hooks\.js"/);
    // Claude Code matches the rule's prefix against the command text, quotes included: a rule without
    // the quotes does not cover the quoted command (verified: "This command requires approval").
    const rule = md.match(/^allowed-tools: Bash\((.*):\*\)$/m);
    assert.ok(rule, `${c}: allowed-tools rule`);
    const cmds = [...md.matchAll(/`(node "[^`"]*bin\/hooks\.js" [^`]*)`/g)].map((m) => m[1]);
    assert.ok(cmds.length, `${c}: a node command in the body`);
    for (const cmd of cmds) assert.ok(cmd.startsWith(rule[1]), `${c}: "${cmd}" is covered by Bash(${rule[1]}:*)`);
    assert.doesNotMatch(md, /\bsh\b.*bin\/intent\b/);
  }
  const prove = fs.readFileSync(path.join(ROOT, "commands", "prove.md"), "utf8");
  assert.match(prove, /allowed-tools: Bash\(intent-check:\*\)/);
  assert.match(prove, /`intent-check --version`/);
  assert.doesNotMatch(prove, /bin\/hooks\.js/);
});

test("bin/intent: the legacy sh launcher (no hook or command uses it any more) still exists and routes to bin/hooks.js", () => {
  for (const f of ["hooks/hooks.json", "hooks/codex-hooks.json"]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /bin\/intent["\s]/, `${f} must not use the sh launcher`);
  const p = path.join(ROOT, "bin", "intent");
  const src = fs.readFileSync(p, "utf8");
  assert.match(src, /^#!\/bin\/sh/);
  assert.match(src, /hooks\.js/);
  assert.ok(isExecutable(p), "bin/intent must be executable");
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

test("Codex: its own manifest and shell-string hook file (node, one command line for sh, cmd and PowerShell), sync Stop, nothing Claude-only", () => {
  const c = read(".codex-plugin/plugin.json");
  assert.equal(c.name, "intent");
  assert.equal(c.version, read(".claude-plugin/plugin.json").version);
  assert.equal(c.hooks, "./hooks/codex-hooks.json");
  const h = read("hooks/codex-hooks.json").hooks;
  const events = { SessionStart: "session-start", UserPromptSubmit: "prompt", PostToolUse: "post-tool", Stop: "stop" };
  assert.deepEqual(Object.keys(h).sort(), Object.keys(events).sort());
  for (const [ev, arg] of Object.entries(events)) {
    const [cmd] = h[ev][0].hooks;
    assert.equal(cmd.command, `node "${"$"}{CLAUDE_PLUGIN_ROOT}/bin/hooks.js" ${arg} --host codex`);
    for (const k of ["args", "async", "asyncRewake", "statusMessage"]) assert.equal(k in cmd, false, `${ev}.${k}`);
  }
  assert.equal(h.PostToolUse[0].matcher, "^(apply_patch|Edit|Write|Bash)$");
  assert.equal(h.Stop[0].hooks[0].timeout, 30);
});
