// Integration: the real `claude -p` loads the hook-free plugin against a
// mock Anthropic API and the fake prover. LLM-free: no real model, no secrets. Run on every OS in CI
// (see .github/workflows/ci.yml); skips cleanly when the `claude` CLI is not installed.
//   node --test test/integration/claude-hooks.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockAnthropic } from "../helpers/mock-anthropic.js";
import { createFakeProver, TEST_KEY } from "../helpers/fake-prover.js";
import { ROOT, tmpdir, makeRepo } from "../helpers/env.js";
import { findCli, runCli, cleanEnv } from "./helpers.js";

const CLAUDE = findCli("claude");
const skip = CLAUDE ? false : "the `claude` CLI is not installed";
const CODE = Array.from({ length: 6 }, (_, i) => `export const v${i} = ${i} * 2;`).join("\n") + "\n";

let fp;
let mock;
before(async () => {
  if (skip) return;
  fp = createFakeProver({ pollsBeforeDone: 0, scenario: "no_concerns" });
  await fp.listen();
});
after(async () => {
  if (fp) await fp.close();
});

// One headless turn in a throwaway project and HOME. `key` seeds a connected account.
async function session({ key = null, prompt = "write the file" } = {}) {
  const home = tmpdir("intent-it-home-");
  const config = path.join(home, ".claude");
  fs.mkdirSync(config, { recursive: true });
  // realpath: on Windows the temp dir can be an 8.3 short name, which Claude Code resolves differently
  const repo = fs.realpathSync.native(makeRepo().dir);
  mock = createMockAnthropic({ cwd: repo, file: "src/a.js", content: CODE });
  await mock.listen();
  const env = cleanEnv({
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: "sk-ant-dummy-not-a-real-key",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    INTENT_API_URL: fp.url,
    INTENT_CONSOLE_URL: fp.url,
    ...(key ? { INTENT_API_KEY: key } : {}),
  });
  const args = ["-p", prompt, "--plugin-dir", ROOT, "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose", "--include-hook-events"];
  const r = await runCli(CLAUDE, args, { env, cwd: repo, timeoutMs: 55000 });
  const events = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const hooks = (kind) => events.filter((e) => e.type === "system" && e.subtype === kind);
  const done = { mockBodies: mock.requests.map((q) => JSON.stringify(q.body || "")).join("\n"), repo, events, hooks, r };
  await mock.close();
  return done;
}

const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
const toolResults = (s) => JSON.stringify(s.events.filter((e) => e.type === "user").map((e) => (e.message && e.message.content) || []).flat().filter((b) => b && b.type === "tool_result").map((b) => b.content)).slice(0, 800);
const note = (s, what) => `${what}\ntool results: ${toolResults(s)}\nwrote: ${fs.existsSync(path.join(s.repo, "src", "a.js"))}\nstderr: ${s.r.stderr.slice(-1500)}\nhook events: ${JSON.stringify(s.hooks("hook_response").map((e) => [e.hook_event, e.outcome, e.exit_code, String(e.stderr || "").slice(0, 200)]))}`;

function assertNoHooks(s) {
  for (const ev of EVENTS) {
    assert.equal(s.hooks("hook_started").filter((e) => e.hook_event === ev).length, 0, note(s, `unexpected ${ev} hook`));
  }
  assert.equal(s.r.code, 0, note(s, "turn completes"));
  assert.ok(fs.existsSync(path.join(s.repo, "src", "a.js")), note(s, "edit happened"));
  assert.equal(fs.existsSync(path.join(s.repo, ".intent")), false, "ordinary edit creates no evidence/capture folder");
  assert.ok(!s.r.timedOut, note(s, "claude -p timed out"));
}

test("claude -p without sign-in: ordinary edits trigger no hooks, login or uploads", { skip, timeout: 60000 }, async () => {
  const s = await session();
  assertNoHooks(s);
  assert.equal(fp.state.requests.length, 0);
});

test("claude -p with a seeded key: ordinary edits still cause no service requests", { skip, timeout: 60000 }, async () => {
  const s = await session({ key: TEST_KEY });
  assertNoHooks(s);
  assert.equal(fp.state.requests.length, 0);
});
