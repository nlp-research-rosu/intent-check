import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, tmpdir, isExecutable } from "./helpers/env.js";

test("bin/intent runs explicit command help", { skip: process.platform === "win32" }, () => {
  assert.ok(isExecutable(path.join(ROOT, "bin", "intent")));
  const result = spawnSync(path.join(ROOT, "bin", "intent"), ["--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deepscan collect/);
  assert.doesNotMatch(result.stdout, /intent (on|live|off)/);
});

test("legacy launcher hook calls exit before looking for Node", { skip: process.platform === "win32" }, () => {
  for (const command of ["session-start", "prompt", "post-tool", "stop", "edit-detached", "finish", "deepscan-wait"]) {
    const result = spawnSync("/bin/sh", [path.join(ROOT, "bin", "intent"), command], { env: { PATH: tmpdir() }, encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, "");
  }
});
