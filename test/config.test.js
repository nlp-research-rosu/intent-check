import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, ROOT } from "./helpers/env.js";
import { isInteractiveEntrypoint } from "../lib/config.js";

// Evaluate config in a child process so env changes do not leak between cases.
function probe(env, files = {}) {
  const data = tmpdir("intent-cfg-");
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(data, f), JSON.stringify(v));
  const code = `import("${path.join(ROOT, "lib", "config.js")}").then((c) => console.log(JSON.stringify({ url: c.apiUrl(), key: c.apiKey(), off: c.disabledReason(), v: c.pluginVersion() })))`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("INTENT_") && k !== "DO_NOT_TRACK"));
  return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: { ...clean, CLAUDE_PLUGIN_DATA: data, ...env } }).toString());
}

test("API base: INTENT_API_URL, then config.json api_url, then the compiled default", () => {
  assert.equal(probe({}).url, "https://web-staging-7e1c.up.railway.app");
  assert.equal(probe({}, { "config.json": { api_url: "https://cfg.example/" } }).url, "https://cfg.example");
  assert.equal(probe({ INTENT_API_URL: "http://127.0.0.1:1" }, { "config.json": { api_url: "https://cfg.example" } }).url, "http://127.0.0.1:1");
});

test("API key: INTENT_API_KEY, then config.json api_key", () => {
  assert.deepEqual(probe({}).key, { key: null, source: null });
  assert.deepEqual(probe({}, { "config.json": { api_key: "ic_cfg" } }).key, { key: "ic_cfg", source: "config" });
  assert.deepEqual(probe({ INTENT_API_KEY: "ic_env" }, { "config.json": { api_key: "ic_cfg" } }).key, { key: "ic_env", source: "env" });
});

test("API key is per service: keys[api_url], env still wins, the legacy field counts until rejected for that URL", () => {
  const u = "http://127.0.0.1:1";
  const files = { "config.json": { keys: { [u]: "ic_one", "http://other": "ic_two" } } };
  assert.deepEqual(probe({ INTENT_API_URL: u }, files).key, { key: "ic_one", source: "config" });
  assert.deepEqual(probe({ INTENT_API_URL: "http://other" }, files).key, { key: "ic_two", source: "config" });
  assert.deepEqual(probe({ INTENT_API_URL: "http://third" }, files).key, { key: null, source: null });
  assert.deepEqual(probe({ INTENT_API_URL: u, INTENT_API_KEY: "ic_env" }, files).key, { key: "ic_env", source: "env" });
  // keys[url] beats the legacy field; a rejected legacy key is not offered for that URL.
  assert.equal(probe({ INTENT_API_URL: u }, { "config.json": { api_key: "ic_old", keys: { [u]: "ic_new" } } }).key.key, "ic_new");
  assert.deepEqual(probe({ INTENT_API_URL: u }, { "config.json": { api_key: "ic_old", legacy_rejected: [u] } }).key, { key: null, source: null });
  assert.equal(probe({ INTENT_API_URL: "http://other" }, { "config.json": { api_key: "ic_old", legacy_rejected: [u] } }).key.key, "ic_old");
});

test("off switches and plugin version", () => {
  assert.equal(probe({}).off, null);
  assert.equal(probe({ INTENT_DISABLED: "1" }).off, "INTENT_DISABLED");
  assert.equal(probe({ DO_NOT_TRACK: "1" }).off, "DO_NOT_TRACK");
  assert.equal(probe({}, { "config.json": { disabled: true } }).off, "off");
  assert.equal(probe({}).v, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
});

test("isInteractiveEntrypoint: only the SDKs, local-agent and mcp are non-interactive", () => {
  for (const e of ["sdk-cli", "sdk-ts", "sdk-py", "local-agent", "mcp"]) {
    assert.equal(isInteractiveEntrypoint(e), false, e);
  }
  for (const e of ["cli", "claude-vscode", "claude-desktop", "claude-jetbrains", "", undefined, "anything-else"]) {
    assert.equal(isInteractiveEntrypoint(e), true, String(e));
  }
});
