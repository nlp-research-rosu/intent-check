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
  assert.equal(probe({}).url, "https://web-per-edit.up.railway.app");
  assert.equal(probe({}, { "config.json": { api_url: "https://cfg.example/" } }).url, "https://cfg.example");
  assert.equal(probe({ INTENT_API_URL: "http://127.0.0.1:1" }, { "config.json": { api_url: "https://cfg.example" } }).url, "http://127.0.0.1:1");
});

test("API key: INTENT_API_KEY, then config.json api_key", () => {
  assert.deepEqual(probe({}).key, { key: null, source: null });
  assert.deepEqual(probe({}, { "config.json": { api_key: "ic_cfg" } }).key, { key: "ic_cfg", source: "config" });
  assert.deepEqual(probe({ INTENT_API_KEY: "ic_env" }, { "config.json": { api_key: "ic_cfg" } }).key, { key: "ic_env", source: "env" });
});

test("off switches and plugin version", () => {
  assert.equal(probe({}).off, null);
  assert.equal(probe({ INTENT_DISABLED: "1" }).off, "INTENT_DISABLED");
  assert.equal(probe({ DO_NOT_TRACK: "1" }).off, "DO_NOT_TRACK");
  assert.equal(probe({}, { "config.json": { disabled: true } }).off, "off");
  assert.equal(probe({}).v, "0.1.1-peredit");
});

test("isInteractiveEntrypoint: only the SDKs, local-agent and mcp are non-interactive", () => {
  for (const e of ["sdk-cli", "sdk-ts", "sdk-py", "local-agent", "mcp"]) {
    assert.equal(isInteractiveEntrypoint(e), false, e);
  }
  for (const e of ["cli", "claude-vscode", "claude-desktop", "claude-jetbrains", "", undefined, "anything-else"]) {
    assert.equal(isInteractiveEntrypoint(e), true, String(e));
  }
});
