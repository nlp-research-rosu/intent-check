import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createFakeProver } from "./helpers/fake-prover.js";
import { tmpdir, baseEnv, runHook, credentialsPath, savedKey, assertOwnerOnly, BIN, PLUGIN_VERSION } from "./helpers/env.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());

function setup(extra = {}, settings = {}) {
  const data = tmpdir("intent-cfg-");
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify(settings));
  return { data, env: baseEnv(data, fp.url, extra) };
}

function config(env) {
  return JSON.parse(execFileSync(BIN, ["config"], { env, encoding: "utf8" })).config;
}

function credentials(data, keys, mode = 0o600) {
  const file = credentialsPath(data);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ keys }), { mode });
  fs.chmodSync(file, mode);
}

test("native API and console bases: environment or shared defaults, never host-local endpoints", () => {
  const { env } = setup({}, { api_url: "https://cfg.example/" });
  delete env.INTENT_API_URL;
  delete env.INTENT_CONSOLE_URL;
  assert.equal(config(env).server_url, "https://prover.intentcomputing.org");
  assert.equal(config(env).portal_url, "https://prover-console.intentcomputing.org");
  env.INTENT_API_URL = `${fp.url}/`;
  env.INTENT_CONSOLE_URL = "https://staging-prover-console.intentcomputing.org/";
  assert.equal(config(env).server_url, fp.url);
  assert.equal(config(env).portal_url, "https://staging-prover-console.intentcomputing.org");
});

test("native key selection: environment, then saved API-origin key", async () => {
  for (const [keys, extra, expected, source] of [
    [{}, {}, null, "none"],
    [{ [fp.url]: "opaque-one", "http://other": "opaque-two" }, {}, "opaque-one", "credentials.json"],
    [{ [fp.url]: "opaque-one" }, { INTENT_API_URL: `${fp.url}/` }, "opaque-one", "credentials.json"],
    [{ "http://other": "opaque-two" }, {}, null, "none"],
    [{ [fp.url]: "opaque-one" }, { INTENT_API_KEY: "from-env" }, "from-env", "INTENT_API_KEY"],
  ]) {
    const ctx = setup(extra);
    credentials(ctx.data, keys);
    fp.state.key = expected || "unused";
    const n = fp.state.requests.length;
    const result = await runHook("doctor", undefined, ctx.env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(source), result.stdout);
    const requests = fp.state.requests.slice(n);
    if (expected) {
      assert.match(result.stdout, /Account: key accepted/);
      assert.equal(requests.find(r => r.path === "/tasks").headers.authorization, `Bearer ${expected}`);
    } else {
      assert.match(result.stdout, /Key source: none/);
      assert.equal(requests.length, 0);
    }
  }
});

test("native credentials readable by others are refused and explained", { skip: process.platform === "win32" }, async () => {
  const ctx = setup();
  credentials(ctx.data, { [fp.url]: "opaque-one" }, 0o644);
  const result = await runHook("doctor", undefined, ctx.env);
  assert.match(result.stdout, /Credential problem: .*readable only by their owner/);
  assert.match(result.stdout, /Key source: none/);
});

test("native rejected-key removal preserves other origins and private credentials", async () => {
  const ctx = setup();
  credentials(ctx.data, { "http://127.0.0.1:1": "k-one", [fp.url]: "k-two" });
  fp.state.key = "different";
  await runHook("doctor", undefined, ctx.env);
  assert.equal(savedKey(ctx.data, fp.url), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(credentialsPath(ctx.data), "utf8")), { keys: { "http://127.0.0.1:1": "k-one" } });
  assertOwnerOnly(credentialsPath(ctx.data));
  assertOwnerOnly(path.dirname(credentialsPath(ctx.data)), 0o700);
});

test("native off switches and plugin version", async () => {
  for (const [extra, settings, off] of [[{}, {}, false], [{ INTENT_DISABLED: "1" }, {}, true], [{ DO_NOT_TRACK: "1" }, {}, true], [{}, { disabled: true }, true]]) {
    const ctx = setup(extra, settings);
    const result = await runHook("doctor", undefined, ctx.env);
    assert.match(result.stdout, new RegExp(`^Intent Check v${PLUGIN_VERSION.replaceAll(".", "\\.")}: ${off ? "off" : "on"}`));
    assert.equal(result.code, 0, result.stderr);
  }
});

test("native live review: environment overrides saved preference", async () => {
  for (const [extra, settings, live] of [[{}, {}, false], [{ INTENT_LIVE: "1" }, {}, true], [{ INTENT_LIVE: "0" }, { live: true }, false], [{ INTENT_LIVE: "bogus" }, { live: true }, true], [{}, { live: true }, true], [{}, { live: false }, false]]) {
    const ctx = setup(extra, settings);
    if (!("INTENT_LIVE" in extra)) delete ctx.env.INTENT_LIVE;
    const result = await runHook("doctor", undefined, ctx.env);
    assert.equal(result.stdout.split("\n")[0].includes("(live)"), live, result.stdout);
  }
});
