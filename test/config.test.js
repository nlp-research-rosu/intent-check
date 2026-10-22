import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir, ROOT } from "./helpers/env.js";
import { isInteractiveEntrypoint } from "../lib/config.js";

// Evaluate config in a child process so env changes do not leak between cases.
function probe(env, files = {}) {
  const data = tmpdir("intent-cfg-");
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(data, f), JSON.stringify(v));
  const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "config.js")).href)}).then((c) => console.log(JSON.stringify({ url: c.apiUrl(), console: c.consoleUrl(), key: c.apiKey(), off: c.disabledReason(), v: c.pluginVersion() })))`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("INTENT_") && k !== "DO_NOT_TRACK"));
  return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: { ...clean, CLAUDE_PLUGIN_DATA: data, ...env } }).toString());
}

test("API base: INTENT_API_URL, then config.json api_url, then the compiled default", () => {
  assert.equal(probe({}).url, "https://prover.intentcomputing.org");
  assert.equal(probe({}, { "config.json": { api_url: "https://cfg.example/" } }).url, "https://cfg.example");
  assert.equal(probe({ INTENT_API_URL: "http://127.0.0.1:1" }, { "config.json": { api_url: "https://cfg.example" } }).url, "http://127.0.0.1:1");
});

test("console base: INTENT_CONSOLE_URL, then the compiled default", () => {
  assert.equal(probe({}).console, "https://prover-console.intentcomputing.org");
  assert.equal(probe({ INTENT_CONSOLE_URL: "https://staging-prover-console.intentcomputing.org/" }).console, "https://staging-prover-console.intentcomputing.org");
});

test("API key: INTENT_API_KEY, then config.json keys", () => {
  assert.deepEqual(probe({}).key, { key: null, source: null });
  assert.deepEqual(probe({ INTENT_API_KEY: "ic_env" }).key, { key: "ic_env", source: "env" });
});

test("API key is per service: keys[api_url], env still wins", () => {
  const u = "http://127.0.0.1:1";
  const files = { "config.json": { keys: { [u]: "ic_one", "http://other": "ic_two" } } };
  assert.deepEqual(probe({ INTENT_API_URL: u }, files).key, { key: "ic_one", source: "config" });
  assert.deepEqual(probe({ INTENT_API_URL: "http://other" }, files).key, { key: "ic_two", source: "config" });
  assert.deepEqual(probe({ INTENT_API_URL: "http://third" }, files).key, { key: null, source: null });
  assert.deepEqual(probe({ INTENT_API_URL: u, INTENT_API_KEY: "ic_env" }, files).key, { key: "ic_env", source: "env" });
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

test("live review: INTENT_LIVE, then config live", () => {
  const live = (env, cfg) => {
    const data = tmpdir("intent-cfg-");
    if (cfg) fs.writeFileSync(path.join(data, "config.json"), JSON.stringify(cfg));
    const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "config.js")).href)}).then((c) => console.log(c.liveMode()))`;
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("INTENT_")));
    return execFileSync(process.execPath, ["-e", code], { env: { ...clean, CLAUDE_PLUGIN_DATA: data, ...env } }).toString().trim();
  };
  assert.equal(live({}), "false");
  assert.equal(live({ INTENT_LIVE: "1" }), "true");
  assert.equal(live({ INTENT_LIVE: "0" }, { live: true }), "false");
  assert.equal(live({ INTENT_LIVE: "bogus" }, { live: true }), "true");
  assert.equal(live({}, { live: true }), "true");
  assert.equal(live({}, { live: false }), "false");
});
