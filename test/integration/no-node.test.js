// Integration: what a user sees when `node` is missing or too old on the PATH Claude Code runs hooks
// with (hooks are exec form: "command": "node"). Claude Code is a native binary, so it runs without
// node; the hooks are what need it. Linux/macOS only (the PATH is a directory of symlinks).
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
  fp = createFakeProver({ pollsBeforeDone: 0, scenario: "no_concerns" });
  await fp.listen();
});
after(async () => {
  if (fp) await fp.close();
});

// Two headless turns against one config dir (so the once-per-data-dir message can be told from a repeat).
async function turns({ oldNode }) {
  const home = tmpdir("intent-it-home-");
  const config = path.join(home, ".claude");
  fs.mkdirSync(config, { recursive: true });
  const repo = fs.realpathSync.native(makeRepo().dir);
  const mock = createMockAnthropic({ cwd: repo, file: "src/a.js", content: CODE });
  await mock.listen();
  const env = cleanEnv({
    HOME: home,
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

test("claude -p with no node on PATH: the turn completes, each hook fails once and does not loop or block", { skip, timeout: 120000 }, async () => {
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
      assert.notEqual(e.outcome, "success", `${e.hook_event} cannot succeed without node`);
      assert.match(String(e.output || e.stderr), /not found|ENOENT/i, `${e.hook_event}: ${e.output}`);
    }
  }
  assert.equal(count(out[0].started, "SessionStart"), 1);
  assert.ok(fs.existsSync(path.join(repo, "src", "a.js")), "the model's edit still happened");
  assert.equal(fp.jobRequests().length, 0, "nothing is sent without node");
});

test("claude -p with Node 16 on PATH: the 'needs Node 18' line shows once per data dir, hooks exit 0", { skip, timeout: 120000 }, async () => {
  const { out } = await turns({ oldNode: true });
  for (const t of out) {
    assert.ok(!t.r.timedOut && t.result && !t.result.is_error, "the turn completed");
    for (const e of t.responses) assert.ok(e.outcome === "success" && e.exit_code === 0, `${e.hook_event} exits 0 on old node`);
    assert.equal(count(t.started, "Stop"), 1);
  }
  const said = (t) => t.responses.filter((e) => /needs Node 18 or newer \(found 16\.1\.0\)/.test(String(e.stderr || e.output))).length;
  assert.equal(said(out[0]), 1, "the first turn says it once");
  assert.equal(said(out[1]), 0, "the second turn in the same data dir stays quiet");
  // The user-visible line is a systemMessage on stdout of SessionStart/UserPromptSubmit, shown once in total.
  const msgs = out.flatMap((t) => t.responses.filter((e) => /"systemMessage"/.test(String(e.stdout))));
  assert.equal(msgs.length, 1, "the systemMessage appears exactly once");
  assert.match(JSON.parse(String(msgs[0].stdout).trim()).systemMessage, /^Intent Check needs Node\.js 18 or newer to run \(found 16\.1\.0\)\. Install it from nodejs\.org, then run \/reload-plugins\.$/);
  for (const t of out) for (const e of t.responses) {
    if (e !== msgs[0]) assert.equal(String(e.stdout || "").trim(), "", `${e.hook_event} prints nothing on stdout`);
  }
});
