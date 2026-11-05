import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir, ROOT } from "./helpers/env.js";

// Evaluate config in a child process so env changes do not leak between cases.
function probe({ XDG, ...env }, files = {}, setup = null) {
  const data = tmpdir("intent-cfg-");
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(data, f), JSON.stringify(v));
  if (setup) setup(data);
  if (XDG) env = { ...env, XDG_CONFIG_HOME: path.join(data, "xdg") };
  const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "config.js")).href)}).then((c) => console.log(JSON.stringify({ url: c.apiUrl(), console: c.consoleUrl(), key: c.apiKey(), problem: c.credentialsProblem(), off: c.disabledReason(), v: c.pluginVersion() })))`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("INTENT_") && k !== "DO_NOT_TRACK"));
  return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: { ...clean, CLAUDE_PLUGIN_DATA: data, ...env } }).toString());
}

test("API base: INTENT_API_URL or the shared default; host-local settings do not select endpoints", () => {
  assert.equal(probe({}).url, "https://prover.intentcomputing.org");
  assert.equal(probe({}, { "config.json": { api_url: "https://cfg.example/" } }).url, "https://prover.intentcomputing.org");
  assert.equal(probe({ INTENT_API_URL: "http://127.0.0.1:1" }, { "config.json": { api_url: "https://cfg.example" } }).url, "http://127.0.0.1:1");
});

test("console base: INTENT_CONSOLE_URL, then the compiled default", () => {
  assert.equal(probe({}).console, "https://prover-console.intentcomputing.org");
  assert.equal(probe({ INTENT_CONSOLE_URL: "https://staging-prover-console.intentcomputing.org/" }).console, "https://staging-prover-console.intentcomputing.org");
});

const creds = (keys, mode = 0o600) => (dir) => {
  fs.mkdirSync(path.join(dir, "xdg", "intent-check"), { recursive: true });
  fs.writeFileSync(path.join(dir, "xdg", "intent-check", "credentials.json"), JSON.stringify({ keys }), { mode });
};

test("API key: INTENT_API_KEY, then the credentials file entry for the API origin", () => {
  const u = "http://127.0.0.1:1";
  const files = creds({ [u]: "opaque-one", "http://other": "opaque-two" });
  const at = (env, f) => probe({ XDG: true, ...env }, {}, f).key;
  assert.deepEqual(at({}), { key: null, source: null });
  assert.deepEqual(at({ INTENT_API_URL: u }, files), { key: "opaque-one", source: "file" });
  assert.deepEqual(at({ INTENT_API_URL: `${u}/` }, files), { key: "opaque-one", source: "file" }, "keyed by origin");
  assert.deepEqual(at({ INTENT_API_URL: "http://third" }, files), { key: null, source: null });
  assert.deepEqual(at({ INTENT_API_URL: u, INTENT_API_KEY: "from-env" }, files), { key: "from-env", source: "env" });
});

test("a credentials file others can read is not used, and the problem is named", { skip: process.platform === "win32" }, () => {
  const u = "http://127.0.0.1:1";
  const p = probe({ XDG: true, INTENT_API_URL: u }, {}, (dir) => { creds({ [u]: "opaque-one" }, 0o644)(dir); fs.chmodSync(path.join(dir, "xdg", "intent-check", "credentials.json"), 0o644); });
  assert.deepEqual(p.key, { key: null, source: null });
  assert.match(p.problem, /readable by others/);
});

test("Scan environment opt-outs and plugin version", () => {
  assert.equal(probe({}).off, null);
  assert.equal(probe({ INTENT_DISABLED: "1" }).off, "INTENT_DISABLED");
  assert.equal(probe({ DO_NOT_TRACK: "1" }).off, "DO_NOT_TRACK");
  assert.equal(probe({}).v, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
});
