// With no automatic hooks, loading the plugin must not require Node on the host PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockAnthropic } from "../helpers/mock-anthropic.js";
import { createFakeProver } from "../helpers/fake-prover.js";
import { ROOT, tmpdir, makeRepo } from "../helpers/env.js";
import { findCli, runCli, cleanEnv, toolsDir } from "./helpers.js";

const CLAUDE = findCli("claude");
const skip = process.platform === "win32" ? "POSIX-only" : !CLAUDE && "claude is not installed";

test("claude -p without Node loads the plugin and edits without automatic hooks", { skip, timeout: 60000 }, async () => {
  const home = tmpdir("intent-it-home-");
  const config = path.join(home, ".claude");
  fs.mkdirSync(config, { recursive: true });
  const repo = makeRepo().dir;
  const mock = createMockAnthropic({ cwd: repo, file: "src/a.js", content: "export const a = 1;\n" });
  const service = createFakeProver();
  await mock.listen();
  await service.listen();
  try {
    const env = cleanEnv({ HOME: home, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "sk-ant-dummy-not-a-real-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", INTENT_API_URL: service.url, INTENT_CONSOLE_URL: service.url, PATH: toolsDir({ oldNode: false }) });
    const result = await runCli(CLAUDE, ["-p", "write the file", "--plugin-dir", ROOT, "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose", "--include-hook-events"], { env, cwd: repo, timeoutMs: 55000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.doesNotMatch(result.stdout, /"subtype":"hook_started"/);
    assert.ok(fs.existsSync(path.join(repo, "src", "a.js")));
    assert.equal(service.state.requests.length, 0);
  } finally { await mock.close(); await service.close(); }
});
