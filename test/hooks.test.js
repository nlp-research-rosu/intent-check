// Upgrade safety: old registrations cannot resume automatic work in the updated package.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, tmpdir } from "./helpers/env.js";

test("stale hook and worker commands do nothing, even with old Live state", () => {
  const data = tmpdir("intent-upgrade-");
  fs.writeFileSync(path.join(data, "config.json"), '{"live":true,"disabled":false}\n');
  fs.mkdirSync(path.join(data, "sessions"));
  fs.writeFileSync(path.join(data, "sessions", "old.json"), '{"prompts":["private"],"touched":["code.py"],"pending":[]}');
  const before = fs.readFileSync(path.join(data, "config.json"), "utf8");
  for (const command of ["session-start", "prompt", "post-tool", "stop", "stop-detached", "edit-detached", "shell-scan-detached", "finish", "deepscan-wait", "on", "live"]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "hooks.js"), command, "old.json"], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, INTENT_LIVE: "1", INTENT_API_URL: "http://127.0.0.1:1" },
      input: '{"prompt":"private","tool_name":"Write","tool_input":{"file_path":"code.py","content":"private code"}}', encoding: "utf8", timeout: 2000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  assert.equal(fs.readFileSync(path.join(data, "config.json"), "utf8"), before);
  assert.deepEqual(fs.readdirSync(data).sort(), ["config.json", "sessions"]);
});
