// Integration: the real `claude -p` runs the plugin's hooks (hooks/hooks.json, exec form) against a
// mock Anthropic API and the fake prover. LLM-free: no real model, no secrets. Run on every OS in CI
// (see .github/workflows/ci.yml); skips cleanly when the `claude` CLI is not installed.
//   node --test test/integration/claude-hooks.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockAnthropic } from "../helpers/mock-anthropic.js";
import { createFakeProver, TEST_KEY } from "../helpers/fake-prover.js";
import { ROOT, tmpdir, makeRepo, waitFor } from "../helpers/env.js";
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

function assertHooksRan(s) {
  for (const ev of EVENTS) {
    assert.ok(s.hooks("hook_started").some((e) => e.hook_event === ev), note(s, `no hook_started for ${ev}`));
    const resp = s.hooks("hook_response").filter((e) => e.hook_event === ev);
    assert.ok(resp.length, note(s, `no hook_response for ${ev}`));
    for (const e of resp) assert.ok(e.outcome === "success" && e.exit_code === 0, note(s, `${ev} hook did not finish successfully`));
  }
  // Stop has two hooks (stop + connect-wait), each started and each answered, both successfully.
  assert.equal(s.hooks("hook_started").filter((e) => e.hook_event === "Stop").length, 2, note(s, "two Stop hooks start"));
  assert.equal(s.hooks("hook_response").filter((e) => e.hook_event === "Stop").length, 2, note(s, "two Stop hooks respond"));
  assert.ok(!s.r.timedOut, note(s, "claude -p timed out"));
}

test("claude -p without a key: every hook runs, the connect note reaches the model, no job is sent", { skip, timeout: 60000 }, async () => {
  const s = await session();
  assertHooksRan(s);
  assert.match(s.mockBodies, /Intent Check is not connected, so nothing is checked; the user can connect at/, note(s, "connect note missing from the model request"));
  assert.doesNotMatch(s.mockBodies, /do not start on their request until they reply/, "headless gets the soft note, not the wait gate");
  assert.equal(fp.jobRequests().length, 0);
  assert.ok(fp.state.requests.some((q) => q.method === "POST" && q.path === "/v1/connect"), "SessionStart asked the service for a connect link");
});

test("claude -p with a seeded key: the edit is uploaded to the prover as a job", { skip, timeout: 60000 }, async () => {
  const before = fp.jobRequests().length;
  const s = await session({ key: TEST_KEY });
  assertHooksRan(s);
  assert.doesNotMatch(s.mockBodies, /Intent Check is not connected/);
  // claude -p never renders asyncRewake, so Stop hands the upload to a detached process that can
  // outlive the session: wait for it.
  await waitFor(() => fp.jobRequests().length > before, { timeoutMs: 20000 });
  assert.ok(fp.jobRequests().length > before, note(s, "no POST /v1/jobs reached the fake prover"));
  const job = fp.jobRequests().at(-1);
  assert.ok(job.units.some((u) => /a\.js$/.test(u.path)), "the written file is in the job");
});
