// Integration: the real `codex exec` loads the hook-free plugin against a mock
// Responses API (custom model provider) and the fake prover. LLM-free: no real model, no secrets.
// The plugin is installed from this checkout into a throwaway CODEX_HOME.
//   node --test test/integration/codex-plugin.test.js
// Skips cleanly when `codex` is not installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMockResponses } from "../helpers/mock-responses.js";
import { createFakeProver, TEST_KEY } from "../helpers/fake-prover.js";
import { ROOT, tmpdir, makeRepo } from "../helpers/env.js";
import { findCli, runCli, cleanEnv } from "./helpers.js";

const CODEX = findCli("codex");
const skip = CODEX ? false : "the `codex` CLI is not installed";
const CODE = Array.from({ length: 6 }, (_, i) => `export const v${i} = ${i} * 2;`).join("\n") + "\n";

let fp;
before(async () => {
  if (skip) return;
  fp = createFakeProver();
  await fp.listen();
});
after(async () => {
  if (fp) await fp.close();
});

async function session({ key = null } = {}) {
  const repo = makeRepo().dir;
  // The test writes the edit, not Codex: on some CI runners Codex's sandbox is read-only or
  // unavailable. The edit happens during the ordinary model turn; it must not trigger capture.
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

function assertNoHooks(s) {
  assert.ok(!s.r.timedOut, note(s, "codex exec timed out"));
  assert.equal(s.r.code, 0, note(s, "codex exec did not exit 0"));
  assert.equal(s.log, "", note(s, "plugin does not run during ordinary turns"));
  assert.ok(fs.existsSync(path.join(s.repo, "src", "a.js")), "edit happened");
  assert.equal(fs.existsSync(path.join(s.repo, ".intent")), false);
}

test("codex exec with a seeded key: ordinary edits still cause no service requests", { skip, timeout: 60000 }, async () => {
  const s = await session({ key: TEST_KEY });
  assertNoHooks(s);
  assert.equal(fp.state.requests.length, 0);
});
