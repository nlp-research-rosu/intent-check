import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver } from "./helpers/fake-prover.js";
import { tmpdir, makeRepo, baseEnv, runHook, fixture, credentialsPath } from "./helpers/env.js";

test("native requests mask the environment key and all saved service keys, leaving short values alone", async () => {
  const fp = createFakeProver({ scenario: "no_concerns", pollsBeforeDone: 0 });
  fp.state.key = "another opaque value";
  await fp.listen();
  try {
    const data = tmpdir("intent-redact-");
    const file = credentialsPath(data);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ keys: { "https://a.test": "plain-opaque-key-1", "https://b.test": "short" } }), { mode: 0o600 });
    const repo = makeRepo().dir;
    const env = baseEnv(data, fp.url, { INTENT_API_KEY: fp.state.key });
    assert.equal((await runHook("prompt", fixture("prompt", repo), env)).code, 0);
    fs.writeFileSync(path.join(repo, "keys.py"), "a = 'plain-opaque-key-1'\nb = 'another opaque value'\nc = 'short'\nd = 'plain-opaque-key-1'\n");
    const r = await runHook("stop", fixture("stop", repo), env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fp.jobRequests().length, 1, "the native runtime sent a review");
    const request = JSON.stringify(fp.jobRequests()[0]);
    assert.ok(!request.includes("plain-opaque-key-1"), "saved key survived");
    assert.ok(!request.includes("another opaque value"), "environment key survived");
    assert.ok(request.includes("short"), "values under eight characters remain unchanged");
    assert.ok(request.includes("‹redacted:intent-key›"));
  } finally {
    await fp.close();
  }
});
