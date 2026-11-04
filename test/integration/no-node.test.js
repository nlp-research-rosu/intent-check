// Integration: native hooks work when node is missing or old on Claude Code's PATH.
// Linux/macOS only (the isolated PATH is a directory of symlinks).
//   node --test test/integration/no-node.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockAnthropic } from "../helpers/mock-anthropic.js";
import { createFakeProver } from "../helpers/fake-prover.js";
import { ROOT, tmpdir, makeRepo } from "../helpers/env.js";
import { findCli, runCli, cleanEnv, toolsDir } from "./helpers.js";

const CLAUDE = findCli("claude");
const skip = process.platform === "win32" ? "POSIX-only (PATH of symlinks)" : CLAUDE ? false : "the `claude` CLI is not installed";
const CODE = Array.from({ length: 6 }, (_, i) => `export const v${i} = ${i} * 2;`).join("\n") + "\n";

let fp;
before(async () => {
  if (skip) return;
  fp = createFakeProver({ pollsBeforeDone: 0, scenario: "no_concerns", connectStatus: "denied" });
  await fp.listen();
});
after(async () => {
  if (fp) await fp.close();
});

// Two headless turns against one config dir, without credentials, to check consent and upload protection.
async function turns({ oldNode }) {
  const home = tmpdir("intent-it-home-");
  const config = path.join(home, ".claude");
  fs.mkdirSync(config, { recursive: true });
  const repo = fs.realpathSync.native(makeRepo().dir);
  const mock = createMockAnthropic({ cwd: repo, file: "src/a.js", content: CODE });
  await mock.listen();
  const env = cleanEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: "sk-ant-dummy-not-a-real-key",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    INTENT_API_URL: fp.url,
    INTENT_CONSOLE_URL: fp.url,
    PATH: toolsDir({ oldNode }),
  });
  const out = [];
  try {
    for (const prompt of ["write the file", "write it again"]) {
      const r = await runCli(CLAUDE, ["-p", prompt, "--plugin-dir", ROOT, "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose", "--include-hook-events"], { env, cwd: repo, timeoutMs: 55000 });
      const events = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const sys = (kind) => events.filter((e) => e.type === "system" && e.subtype === kind);
      out.push({ r, events, started: sys("hook_started"), responses: sys("hook_response"), result: events.find((e) => e.type === "result") });
    }
  } finally {
    await mock.close();
  }
  return { out, repo };
}

const count = (list, ev) => list.filter((e) => e.hook_event === ev).length;

function assertNativeOutput(response) {
  if (!String(response.stdout || "").trim()) return;
  const output = JSON.parse(String(response.stdout));
  assert.ok(output && typeof output === "object" && !Array.isArray(output), "hook output is an object");
  assert.ok("systemMessage" in output || "hookSpecificOutput" in output, "hook output contains a message or context");
  if ("systemMessage" in output) {
    assert.equal(typeof output.systemMessage, "string");
    assert.ok(output.systemMessage.trim(), "systemMessage is not empty");
  }
  if ("hookSpecificOutput" in output) {
    const context = output.hookSpecificOutput;
    assert.ok(context && typeof context === "object" && !Array.isArray(context), "hookSpecificOutput is an object");
    assert.equal(context.hookEventName, response.hook_event);
    assert.equal(typeof context.additionalContext, "string");
    assert.ok(context.additionalContext.trim(), "additionalContext is not empty");
  }
}

test("claude -p with no node on PATH: native hooks succeed once without looping or uploading without a key", { skip, timeout: 120000 }, async () => {
  const { out, repo } = await turns({ oldNode: false });
  for (const t of out) {
    assert.ok(!t.r.timedOut, "the turn did not hang");
    assert.ok(t.result && !t.result.is_error, `the turn completed: ${t.r.stdout.slice(-400)}`);
    // One hook per event, including a single review Stop hook: nothing repeats.
    assert.equal(count(t.started, "UserPromptSubmit"), 1);
    assert.equal(count(t.started, "PostToolUse"), 1);
    assert.equal(count(t.started, "Stop"), 1);
    assert.equal(t.responses.length, t.started.length, "every started hook was answered");
    for (const e of t.responses) {
      assert.ok(e.outcome === "success" && e.exit_code === 0, `${e.hook_event} succeeds without node`);
      assert.doesNotMatch(String(e.stdout || "") + String(e.stderr || ""), /needs Node(?:\.js)? 18/);
      assertNativeOutput(e);
    }
  }
  assert.equal(count(out[0].started, "SessionStart"), 1);
  assert.equal(out[0].responses.filter((e) => /Intent Check is on\./.test(String(e.stdout))).length, 1, "consent is shown without node");
  assert.equal(out[1].responses.filter((e) => /Intent Check is on\./.test(String(e.stdout))).length, 0, "consent is not repeated");
  assert.ok(fs.existsSync(path.join(repo, "src", "a.js")), "the model's edit still happened");
  assert.equal(fp.jobRequests().length, 0, "nothing is sent without an API key");
});

test("claude -p with Node 16 on PATH: native hooks succeed and consent shows once per data dir", { skip, timeout: 120000 }, async () => {
  const { out, repo } = await turns({ oldNode: true });
  for (const t of out) {
    assert.ok(!t.r.timedOut && t.result && !t.result.is_error, "the turn completed");
    assert.equal(count(t.started, "UserPromptSubmit"), 1);
    assert.equal(count(t.started, "PostToolUse"), 1);
    assert.equal(count(t.started, "Stop"), 1);
    assert.equal(t.responses.length, t.started.length, "every started hook was answered");
    for (const e of t.responses) {
      assert.ok(e.outcome === "success" && e.exit_code === 0, `${e.hook_event} exits 0 on old node`);
      assert.doesNotMatch(String(e.stdout || "") + String(e.stderr || ""), /needs Node(?:\.js)? 18/);
      assertNativeOutput(e);
    }
  }
  const consent = (t) => t.responses.filter((e) => /Intent Check is on\./.test(String(e.stdout)));
  const said = (t) => consent(t).length;
  assert.equal(said(out[0]), 1, "the first turn says it once");
  assert.equal(said(out[1]), 0, "the second turn in the same data dir stays quiet");
  // Consent is shown once; separate sign-in guidance may also appear while disconnected.
  const msgs = out.flatMap(consent);
  assert.equal(msgs.length, 1, "the consent systemMessage appears exactly once");
  const message = JSON.parse(String(msgs[0].stdout).trim()).systemMessage;
  assert.match(message, /^Intent Check is on\./);
  assert.match(message, /\.intent\/\.sent\.log/);
  assert.match(message, /\/intent:off/);
  assert.equal(count(out[0].started, "SessionStart"), 1);
  assert.ok(fs.existsSync(path.join(repo, "src", "a.js")), "the model's edit still happened");
  assert.equal(fp.jobRequests().length, 0, "nothing is sent without an API key");
});
