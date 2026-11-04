import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, tmpdir, makeRepo, baseEnv, runHook, readSessionFiles } from "./helpers/env.js";

test("concurrent native hook processes do not lose session updates", async () => {
  const data = tmpdir("intent-state-");
  const repo = makeRepo({ git: false }).dir;
  const env = baseEnv(data, "http://127.0.0.1:9", { HOME: repo, USERPROFILE: repo });
  await Promise.all([1, 2, 3, 4].map(async (worker) => {
    for (let i = 0; i < 20; i++) {
      const r = await runHook("prompt", fixture("prompt", repo, { prompt: `worker ${worker} prompt ${i}` }), env);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
    }
  }));
  assert.equal(readSessionFiles(data)[0].prompt_count, 80);
});
