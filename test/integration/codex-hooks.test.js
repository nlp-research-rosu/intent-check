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
import { findCli, runCli, cleanEnv } from "./helpers.js";

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

async function session({ key = null } = {}) {
  const repo = makeRepo().dir;
  // The test writes the edit, not Codex: on some CI runners Codex's sandbox is read-only or
  // unavailable ("patch rejected: writing is blocked by read-only sandbox"), and what is under test
  // is the plugin's hooks. It happens when the model request arrives, i.e. after the turn started
  // (the plugin snapshots the repo at UserPromptSubmit), so it counts as this turn's edit; Stop finds
  // it through the repo's diff.
  const edit = () => {
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
    CODEX_HOME: codexHome,
    INTENT_API_URL: fp.url,
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
    const r = await cx(["exec", "--skip-git-repo-check", "-s", "workspace-write", "--json", "write the file"]);
    const events = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const bodies = mock.requests.map((q) => q.raw).join("\n");
    const log = (() => { try { return fs.readFileSync(path.join(codexHome, "plugins", "data", "intent-intentcomputing", "intent.log"), "utf8"); } catch { return ""; } })();
    return { r, events, bodies, log, repo, mock };
  } finally {
    await mock.close();
  }
}

const note = (s, what) => `${what}\nexit: ${s.r.code}${s.r.timedOut ? " (timed out)" : ""}\nstdout: ${s.r.stdout.slice(-1500)}\nstderr: ${s.r.stderr.slice(-1500)}\nplugin log: ${s.log.slice(-1500)}`;

// The plugin logs `hook.in` for every hook it is started for.
function assertHooksRan(s, events) {
  for (const ev of events) assert.match(s.log, new RegExp(`"event":"hook.in","hook":"${ev}"`), note(s, `the ${ev} hook never ran`));
}

test("codex exec without a key: hooks run, the connect line reaches the model, no job is sent", { skip, timeout: 60000 }, async () => {
  const s = await session();
  assertHooksRan(s, ["SessionStart", "UserPromptSubmit", "Stop"]);
  assert.match(s.bodies, /Intent Check: connect your account/, note(s, "connect line missing from the model request"));
  assert.equal(fp.jobRequests().length, 0);
});

test("codex exec with a seeded key: the edit is uploaded to the prover as a job", { skip, timeout: 60000 }, async () => {
  const before = fp.jobRequests().length;
  const s = await session({ key: TEST_KEY });
  // No PostToolUse here: the mock model makes no tool call (Codex 0.147 does not dispatch it for
  // apply_patch anyway). The Stop hook finds the edit through the repo's diff.
  assertHooksRan(s, ["SessionStart", "UserPromptSubmit", "Stop"]);
  await waitFor(() => fp.jobRequests().length > before, { timeoutMs: 20000 });
  assert.ok(fp.jobRequests().length > before, note(s, "no POST /v1/jobs reached the fake prover"));
});
