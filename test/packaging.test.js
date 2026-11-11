import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, isExecutable } from "./helpers/env.js";

const read = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));

test("marketplace and manifests share one plugin version", () => {
  const marketplace = read(".claude-plugin/marketplace.json");
  assert.equal(marketplace.name, "intentcomputing");
  assert.equal(marketplace.plugins[0].name, "intent");
  assert.equal(marketplace.plugins[0].source.ref, `v${marketplace.plugins[0].version}`);
  const version = read("package.json").version;
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  for (const name of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    assert.equal(read(name).version, version);
    assert.equal(read(name).hooks, undefined);
  }
  assert.equal(marketplace.plugins[0].version, version);
});

test("plugins register no automatic hooks", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "hooks")), false);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "bin")).sort(), ["intent", "intent.js"]);
});

test("only Scan, Prove and diagnostics are callable commands", () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "commands")).sort(), ["doctor.md", "prove.md", "scan.md"]);
  for (const command of ["scan", "doctor"]) {
    const text = fs.readFileSync(path.join(ROOT, "commands", `${command}.md`), "utf8");
    assert.match(text, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/intent\.js"/);
  }
  assert.match(fs.readFileSync(path.join(ROOT, "commands", "prove.md"), "utf8"), /allowed-tools: Bash\(intent-prover:\*\)/);
  const skill = fs.readFileSync(path.join(ROOT, "skills", "intent-prover", "SKILL.md"), "utf8");
  assert.match(skill, /references\/scan\.md/);
  assert.ok(fs.existsSync(path.join(ROOT, "skills", "intent-prover", "references", "scan.md")));
});

test("explicit launcher is executable and runtime has no dependencies", () => {
  assert.ok(isExecutable(path.join(ROOT, "bin", "intent")));
  assert.equal(read("package.json").dependencies, undefined);
  for (const file of fs.readdirSync(path.join(ROOT, "lib")).filter((name) => name.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(ROOT, "lib", file), "utf8");
    for (const match of text.matchAll(/from "([^"]+)"/g)) {
      assert.match(match[1], /^(node:|\.\/)/);
      if (match[1].startsWith("./")) assert.ok(fs.existsSync(path.resolve(ROOT, "lib", match[1])), `${file}: ${match[1]}`);
    }
    assert.doesNotMatch(text, /spawn\(|transcript_path|captureBaseline/);
  }
});
