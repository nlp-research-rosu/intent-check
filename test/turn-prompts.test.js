// Exercise host turn IDs and asynchronous edit snapshots through native hooks.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { fixture, rewriteProjectDir, tmpdir, makeRepo, baseEnv, runHook, readSessionFiles, saveKey, waitFor, QUIET_GLOBAL, ROOT } from "./helpers/env.js";

const PA = "Add discount helpers. The result must never go below zero.";
const PB = "Now rename everything to snake_case";
const V1 = "def apply_discount(price_cents, percent):\n    return price_cents - price_cents * percent // 100\n\ndef total(items):\n    return sum(items)\n";
let fp;
before(async () => { fp = createFakeProver({ scenario: "no_concerns", pollsBeforeDone: 0 }); await fp.listen(); });
after(() => fp.close());
beforeEach(() => { fp.state.requests.length = 0; });

function setup(extra = {}) {
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, fp.url);
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const repo = makeRepo().dir;
  return { data, repo, env: baseEnv(data, fp.url, extra) };
}
const sendPrompt = (c, text, id) => runHook("prompt", fixture("prompt", c.repo, { prompt: text, prompt_id: id }), c.env);
const codex = (name, c, patch = {}) => ({ ...JSON.parse(rewriteProjectDir(fs.readFileSync(path.join(ROOT, "test/fixtures/codex", `${name}.json`), "utf8"), c.repo)), ...patch });

test("Codex turn_id excludes a later prompt from the outgoing request", async () => {
  const c = setup();
  for (const [prompt, turn_id] of [[PA, "cx-1"], [PB, "cx-2"]]) {
    assert.equal((await runHook("prompt", codex("prompt", c, { prompt, turn_id }), c.env, { host: "codex" })).code, 0);
  }
  assert.deepEqual(readSessionFiles(c.data)[0].prompt_ids, ["cx-1", "cx-2"]);
  fs.writeFileSync(path.join(c.repo, "pricing.py"), V1);
  await runHook("stop", codex("stop", c, { turn_id: "cx-1" }), c.env, { host: "codex" });
  assert.equal(fp.jobRequests().length, 1);
  assert.equal(fp.jobRequests()[0].turn_id, "cx-1");
  assert.deepEqual(fp.jobRequests()[0].intent.prompts, [PA]);
});

test("ids and prompts trim together at max_prompts", async () => {
  const c = setup();
  for (let i = 1; i <= 6; i++) await sendPrompt(c, `prompt number ${i}`, `id-${i}`);
  const [s] = readSessionFiles(c.data);
  assert.equal(s.prompts.length, 4);
  assert.equal(s.prompts.length, s.prompt_ids.length);
  assert.equal(s.prompt_ids.at(-1), "id-6");
  assert.equal(s.prompts.at(-1), "prompt number 6");
});

test("per-edit job snapshot respects the job's prompt_id", async () => {
  const c = setup({ INTENT_LIVE: "1" });
  await sendPrompt(c, PA, "turn-aaaa");
  await sendPrompt(c, PB, "turn-bbbb");
  const abs = path.join(c.repo, "pricing.py");
  fs.writeFileSync(abs, V1);
  await runHook("post-tool", fixture("post-tool-write", c.repo, { prompt_id: "turn-aaaa", tool_input: { file_path: abs, content: V1 }, tool_use_id: "toolu_a" }), c.env);
  assert.ok(await waitFor(() => fp.jobRequests().length >= 1), "edit job submitted");
  assert.equal(fp.jobRequests()[0].turn_id, "turn-aaaa");
  assert.deepEqual(fp.jobRequests()[0].intent.prompts, [PA]);
});
