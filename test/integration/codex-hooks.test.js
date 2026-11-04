// Integration: the real `codex exec` runs the plugin's hooks (hooks/codex-hooks.json) against a mock
// Responses API (custom model provider) and the fake prover. LLM-free: no real model, no secrets.
// The plugin is installed from this checkout into a throwaway CODEX_HOME and its hooks are trusted
// the same way test/e2e/codex-e2e.sh does it (hash entries in that home's config.toml only).
//   node --test test/integration/codex-hooks.test.js
// Skips cleanly when `codex` is not installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockResponses } from "../helpers/mock-responses.js";
import { createFakeProver, TEST_KEY } from "../helpers/fake-prover.js";
import { ROOT, tmpdir, makeRepo, waitFor } from "../helpers/env.js";
import { trustEntries } from "../e2e/codex-trust.mjs";
import { findCli, runCli, cleanEnv, toolsDir } from "./helpers.js";

const CODEX = findCli("codex");
const skip = CODEX ? false : "the `codex` CLI is not installed";
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

async function session({ key = null, noNode = false } = {}) {
  const repo = makeRepo().dir;
  // The test writes the edit, not Codex: on some CI runners Codex's sandbox is read-only or
  // unavailable ("patch rejected: writing is blocked by read-only sandbox"), and what is under test
  // is the plugin's hooks. It happens when the model request arrives, i.e. after the turn started
  // (the plugin snapshots the repo at UserPromptSubmit), so it counts as this turn's edit; Stop finds
  // it through the repo's diff.
  let edited = false;
  const edit = () => {
    if (edited) return;
    edited = true;
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "a.js"), CODE);
  };
  const mock = createMockResponses({ write: false, onModelRequest: edit });
  await mock.listen();
  const home = tmpdir("intent-it-codex-");
  const codexHome = path.join(home, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const env = cleanEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    CODEX_HOME: codexHome,
    INTENT_API_URL: fp.url,
    INTENT_CONSOLE_URL: fp.url,
    INTENT_DEBUG: "1",
    MOCK_API_KEY: "dummy-not-a-real-key",
    ...(key ? { INTENT_API_KEY: key } : {}),
  });
  const cx = (args, o = {}) => runCli(CODEX, args, { env, cwd: repo, timeoutMs: 40000, input: "", ...o }); // stdin closed: codex exec otherwise waits on "additional input"
  try {
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      'model = "gpt-5.6-luna"', // a model in Codex's bundled catalog, so it offers the apply_patch tool
      'model_provider = "mock"',
      'approval_policy = "never"',
      "",
      "[model_providers.mock]",
      'name = "Mock"',
      `base_url = "${mock.url}/v1"`,
      'env_key = "MOCK_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n"));
    const m = await cx(["plugin", "marketplace", "add", ROOT]);
    assert.equal(m.code, 0, `marketplace add: ${m.stdout}${m.stderr}`);
    const a = await cx(["plugin", "add", "intent@intentcomputing"]);
    assert.equal(a.code, 0, `plugin add: ${a.stdout}${a.stderr}`);
    fs.appendFileSync(path.join(codexHome, "config.toml"), "\n" + trustEntries() + "\n");
    const r = await cx(["exec", "--skip-git-repo-check", "-s", "workspace-write", "--json", "write the file"], noNode ? { env: { ...env, PATH: toolsDir() } } : {});
    const events = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const bodies = mock.requests.map((q) => q.raw).join("\n");
    const log = (() => { try { return fs.readFileSync(path.join(codexHome, "plugins", "data", "intent-intentcomputing", "intent.log"), "utf8"); } catch { return ""; } })();
    const records = log.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    for (const record of records) {
      assert.ok(record && typeof record === "object" && !Array.isArray(record), "plugin log record is an object");
      assert.equal(typeof record.event, "string", "plugin log record has an event");
    }
    return { r, events, bodies, log, records, repo, mock };
  } finally {
    await mock.close();
  }
}

const note = (s, what) => `${what}\nexit: ${s.r.code}${s.r.timedOut ? " (timed out)" : ""}\nstdout: ${s.r.stdout.slice(-1500)}\nstderr: ${s.r.stderr.slice(-1500)}\nplugin log: ${s.log.slice(-1500)}`;

// What this proves: the plugin logs `hook.in` for every hook it is started for, and `hook.output` when
// it hands text to Codex (SessionStart always does; UserPromptSubmit does when there is something to
// say, e.g. setup guidance); with a key, Stop's own work shows as a `job.submitted` entry. Codex
// itself reports no per-hook result in `exec --json`, so the exit code and the absence of a timeout
// are the only host-side signal that no hook hung or failed the turn.
function assertHooksRan(s, events, outputs = ["SessionStart"]) {
  assert.ok(!s.r.timedOut, note(s, "codex exec timed out"));
  assert.equal(s.r.code, 0, note(s, "codex exec did not exit 0"));
  for (const ev of events) {
    assert.ok(s.records.some((r) => r.event === "hook.in" && r.hook === ev), note(s, `the ${ev} hook never ran`));
    const responses = s.records.filter((r) => r.event === "hook.output" && r.hook === ev);
    assert.ok(responses.length, note(s, `the ${ev} hook never finished`));
    for (const response of responses) assert.equal(response.exit, 0, note(s, `the ${ev} hook did not exit 0`));
  }
  for (const ev of outputs) assert.ok(s.records.some((r) => r.event === "hook.output" && r.hook === ev && Number.isInteger(r.stdout_bytes) && r.stdout_bytes > 0), note(s, `the ${ev} hook handed nothing to Codex`));
}

test("codex exec without a global CLI: hooks give setup guidance, no job is sent", { skip, timeout: 60000 }, async () => {
  const s = await session();
  assertHooksRan(s, ["SessionStart", "UserPromptSubmit", "Stop"]);
  assert.match(s.bodies, /setup/, note(s, "setup guidance missing from the model request"));
  assert.equal(fp.jobRequests().length, 0);
});

test("codex exec with a seeded key: the edit is uploaded to the prover as a job", { skip, timeout: 60000 }, async () => {
  const before = fp.jobRequests().length;
  const s = await session({ key: TEST_KEY });
  // No PostToolUse here: the mock model makes no tool call (Codex 0.147 does not dispatch it for
  // apply_patch anyway). The Stop hook finds the edit through the repo's diff.
  assertHooksRan(s, ["SessionStart", "UserPromptSubmit", "Stop"]);
  await waitFor(() => fp.jobRequests().length > before, { timeoutMs: 20000 });
  assert.ok(fp.jobRequests().length > before, note(s, "no POST /intent-checks reached the fake prover"));
  assert.ok(s.records.some((r) => r.event === "job.submitted"), note(s, "Stop did not log a submitted job"));
  assert.ok(fp.jobRequests().at(-1).units.some((u) => /a\.js$/.test(u.path)), "the written file is in the job");
});

// The native plugin must still submit reviews when Node is absent from the hooks' PATH.
test("codex exec without Node on PATH: native hooks run and upload the edit", { skip: skip || (process.platform === "win32" ? "POSIX-only (PATH of symlinks)" : false), timeout: 60000 }, async () => {
  const before = fp.jobRequests().length;
  const s = await session({ key: TEST_KEY, noNode: true });
  assertHooksRan(s, ["SessionStart", "UserPromptSubmit", "Stop"]);
  assert.doesNotMatch(s.bodies, /Intent Prover needs Node/);
  assert.ok(await waitFor(() => fp.jobRequests().length > before, { timeoutMs: 20000 }), note(s, "no review reached the fake prover without Node"));
  assert.ok(fp.jobRequests().at(-1).units.some((u) => /a\.js$/.test(u.path)), "the written file is in the job");
});
