// SessionStart stays bounded when the global CLI is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { TEST_KEY } from "./helpers/fake-prover.js";
import { fixture, tmpdir, makeRepo, baseEnv, runHook, saveKey } from "./helpers/env.js";

test("SessionStart with no global CLI finishes under the watchdog without contacting the service", async (t) => {
  const sockets = [];
  const hang = http.createServer(() => { /* never answers */ });
  hang.on("connection", (s) => sockets.push(s));
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  t.after(() => { for (const s of sockets) s.destroy(); hang.close(); });
  const url = `http://127.0.0.1:${hang.address().port}`;
  const data = tmpdir("intent-data-");
  saveKey(data, TEST_KEY, "http://127.0.0.1:1");
  const repo = makeRepo().dir;
  const r = await runHook("session-start", fixture("session-start", repo), baseEnv(data, url, { PATH: "" }));
  assert.ok(r.ms < 6500, `took ${r.ms}`);
  assert.match(r.json.systemMessage, /Intent Check is on\./);
  assert.match(r.json.systemMessage, /Intent Check v\S+ ready/);
  assert.equal(sockets.length, 0, "hooks do not contact the service to start sign-in");
});
