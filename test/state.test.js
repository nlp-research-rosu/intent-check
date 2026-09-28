import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, ROOT } from "./helpers/env.js";

let st;
let data;
before(async () => {
  data = tmpdir("intent-state-");
  process.env.CLAUDE_PLUGIN_DATA = data;
  st = await import("../lib/state.js");
});

test("session files are keyed by a hash of the session id, mode 600", () => {
  const key = st.sessionKey("abc");
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.notEqual(key, st.sessionKey("abd"));
  st.withSession(key, (s) => { s.touched.push("/x/a.py"); });
  const f = path.join(data, "sessions", `${key}.json`);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(st.loadSession(key).touched, ["/x/a.py"]);
  assert.equal(fs.existsSync(path.join(data, "sessions", `${key}.lock`)), false, "lock released");
});

test("a corrupt or partial state file loads as defaults", () => {
  const key = st.sessionKey("corrupt");
  fs.mkdirSync(path.join(data, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(data, "sessions", `${key}.json`), '{"touched": "nope", "pending": null, "flags": 3');
  const s = st.loadSession(key);
  assert.deepEqual(s.touched, []);
  assert.deepEqual(s.pending, []);
  fs.writeFileSync(path.join(data, "sessions", `${key}.json`), '{"touched": "nope", "pending": null, "flags": 3}');
  assert.deepEqual(st.loadSession(key).flags, {});
});

test("a stale lock left by a crashed process is broken", () => {
  const key = st.sessionKey("stale");
  const lock = path.join(data, "sessions", `${key}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(st.withSession(key, () => "ran"), "ran");
});

test("concurrent writers do not lose updates", async () => {
  const { spawn } = await import("node:child_process");
  const key = st.sessionKey("race");
  const script = `import("${path.join(ROOT, "lib", "state.js")}").then((st) => { for (let i = 0; i < 20; i++) st.withSession("${key}", (s) => { s.touched.push(process.pid + ":" + i); }); })`;
  await Promise.all([1, 2, 3, 4].map(() => new Promise((resolve) => {
    spawn(process.execPath, ["-e", script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: data } }).on("close", resolve);
  })));
  assert.equal(st.loadSession(key).touched.length, 80);
});
