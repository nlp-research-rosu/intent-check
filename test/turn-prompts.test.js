// A prompt that arrives before the previous turn's Stop runs must not be judged against that turn.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { fixture, rewriteProjectDir, tmpdir, makeRepo, baseEnv, runHook, readSessionFiles, saveKey, waitFor, QUIET_GLOBAL, ROOT, BIN } from "./helpers/env.js";

const A = "turn-aaaa";
const B = "turn-bbbb";
const PA = "Add discount helpers. The result must never go below zero.";
const PB = "Now rename everything to snake_case";
const V1 = "def apply_discount(price_cents, percent):\n    return price_cents - price_cents * percent // 100\n\ndef total(items):\n    return sum(items)\n";

let fp;
let st;
let rn;
let ctx;
before(async () => {
  fp = createFakeProver();
  await fp.listen();
  ctx = tmpdir("intent-data-");
  process.env.CLAUDE_PLUGIN_DATA = ctx;
  st = await import("../lib/state.js");
  rn = await import("../lib/runner.js");
});
after(() => fp.close());
beforeEach(() => Object.assign(fp.state, { scenario: "concerns", pollsBeforeDone: 0, submitStatus: null, concern: null, submitDelayMs: 0, idem: new Map() }));
beforeEach(() => { fp.state.requests.length = 0; });

function setup(extra = {}) {
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY);
  fs.writeFileSync(path.join(data, "global.json"), QUIET_GLOBAL);
  const repo = makeRepo().dir;
  return { data, repo, env: baseEnv(data, fp.url, extra) };
}

const sendPrompt = (c, text, id) => runHook("prompt", fixture("prompt", c.repo, { prompt: text, prompt_id: id }), c.env);

function codexPrompt(c, text, id) {
  const raw = rewriteProjectDir(fs.readFileSync(path.join(ROOT, "test", "fixtures", "codex", "prompt.json"), "utf8"), c.repo);
  const payload = { ...JSON.parse(raw), prompt: text, turn_id: id };
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [BIN, "prompt", "--host", "codex"], { env: c.env, cwd: c.repo });
    ch.on("close", resolve);
    ch.stdin.end(JSON.stringify(payload));
  });
}

// consumeTurn runs in this process against `data`; the session key is derived from the fixture's session_id.
function consume(c, turnId) {
  process.env.CLAUDE_PLUGIN_DATA = c.data;
  const sid = fixture("prompt", c.repo).session_id;
  return rn.consumeTurn(st.sessionKey(sid), turnId);
}

test("race: Stop for turn A leaves out the prompt B that arrived first", async () => {
  const c = setup();
  await sendPrompt(c, PA, A);
  await sendPrompt(c, PB, B);
  const [s] = readSessionFiles(c.data);
  assert.deepEqual(s.prompts, [PA, PB]);
  assert.deepEqual(s.prompt_ids, [A, B]);
  const snap = consume(c, A);
  assert.deepEqual(snap.prompts, [PA]);
  assert.equal(snap.turn_id, A);
  assert.equal(snap.first_prompt, PA);
});

test("race: a first_prompt set by the excluded later prompt is not sent", async () => {
  const c = setup();
  await sendPrompt(c, "ok", A); // not substantive
  await sendPrompt(c, "Refactor the whole billing module to use cents everywhere", B);
  const [s] = readSessionFiles(c.data);
  assert.equal(s.first_prompt_id, B);
  const snap = consume(c, A);
  assert.deepEqual(snap.prompts, ["ok"]);
  assert.equal(snap.first_prompt, null);
});

test("normal order: Stop for the latest turn keeps every prompt", async () => {
  const c = setup();
  await sendPrompt(c, PA, A);
  await sendPrompt(c, PB, B);
  const snap = consume(c, B);
  assert.deepEqual(snap.prompts, [PA, PB]);
  assert.equal(snap.turn_id, B);
});

test("unknown or missing id keeps every prompt and the session's turn id", async () => {
  const c = setup();
  await sendPrompt(c, PA, A);
  await sendPrompt(c, PB, B);
  assert.deepEqual(consume(c, "turn-zzzz").prompts, [PA, PB]);
  const snap = consume(c, undefined);
  assert.deepEqual(snap.prompts, [PA, PB]);
  assert.equal(snap.turn_id, B);
});

test("codex: turn_id from the payloads drives the cut", async () => {
  const c = setup();
  await codexPrompt(c, PA, "cx-1");
  await codexPrompt(c, PB, "cx-2");
  const [s] = readSessionFiles(c.data);
  assert.deepEqual(s.prompt_ids, ["cx-1", "cx-2"]);
  process.env.CLAUDE_PLUGIN_DATA = c.data;
  const sid = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "codex", "prompt.json"), "utf8")).session_id;
  const snap = rn.consumeTurn(st.sessionKey(sid), "cx-1");
  assert.deepEqual(snap.prompts, [PA]);
  assert.equal(snap.turn_id, "cx-1");
});

test("ids and prompts trim together at max_prompts", async () => {
  const c = setup();
  for (let i = 1; i <= 6; i++) await sendPrompt(c, `prompt number ${i}`, `id-${i}`);
  const [s] = readSessionFiles(c.data);
  assert.equal(s.prompts.length, s.prompt_ids.length);
  assert.equal(s.prompt_ids.at(-1), "id-6");
  assert.equal(s.prompts.at(-1), "prompt number 6");
});

test("old session files without prompt_ids still work", async () => {
  const c = setup();
  await sendPrompt(c, PA, A);
  const key = st.sessionKey(fixture("prompt", c.repo).session_id);
  const f = path.join(c.data, "sessions", `${key}.json`);
  const old = JSON.parse(fs.readFileSync(f, "utf8"));
  delete old.prompt_ids;
  delete old.first_prompt_id;
  fs.writeFileSync(f, JSON.stringify(old));
  process.env.CLAUDE_PLUGIN_DATA = c.data;
  assert.deepEqual(st.loadSession(key).prompt_ids, []);
  assert.deepEqual(consume(c, A).prompts, [PA]);
  await sendPrompt(c, PB, B);
  const [s] = readSessionFiles(c.data);
  assert.deepEqual(s.prompt_ids, [null, B]);
  assert.deepEqual(consume(c, A).prompts, [PA, PB], "id not found: all prompts");
});

test("per-edit job snapshot respects the job's prompt_id", async () => {
  const c = setup({ INTENT_LIVE: "1" });
  await sendPrompt(c, PA, A);
  await sendPrompt(c, PB, B);
  const abs = path.join(c.repo, "pricing.py");
  fs.writeFileSync(abs, V1);
  await runHook("post-tool", fixture("post-tool-write", c.repo, { prompt_id: A, tool_input: { file_path: abs, content: V1 }, tool_use_id: "toolu_a" }), c.env);
  assert.ok(await waitFor(() => fp.jobRequests().length >= 1), "edit job submitted");
  const req = fp.jobRequests()[0];
  assert.equal(req.turn_id, A);
  assert.deepEqual(req.intent.prompts, [PA]);
});
