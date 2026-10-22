import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = join(root, "test", "fixtures", "api");

test("api key redaction regex catches an example key", () => {
  const c = JSON.parse(readFileSync(join(root, "lib", "constants.json"), "utf8"));
  const key = JSON.parse(readFileSync(join(fx, "examples", "connect-approved.json"), "utf8")).api_key;
  assert.match(`INTENT_API_KEY=${key}`, new RegExp(c.api_key.redaction_regex));
});

test("JobRequest declares per_edit, the boolean per-edit bodies send", () => {
  const schema = JSON.parse(readFileSync(join(fx, "job-v1.schema.json"), "utf8"));
  const req = schema.$defs.JobRequest;
  assert.equal(req.properties.per_edit.type, "boolean");
  assert.equal((req.required || []).includes("per_edit"), false, "optional: classic bodies omit it");
});

test("DeepscanCreated and DeepscanStatus declare budget_s, a required integer the waiter follows", () => {
  const schema = JSON.parse(readFileSync(join(fx, "deepscan-v1.schema.json"), "utf8"));
  for (const name of ["DeepscanCreated", "DeepscanStatus"]) {
    const def = schema.$defs[name];
    assert.equal(def.properties.budget_s.type, "integer", name);
    assert.ok(def.required.includes("budget_s"), name);
  }
});
