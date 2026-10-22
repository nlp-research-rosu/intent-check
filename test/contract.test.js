import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = join(root, "test", "fixtures", "api");

test("JobRequest declares per_edit, the boolean per-edit bodies send", () => {
  const schema = JSON.parse(readFileSync(join(fx, "job-v1.schema.json"), "utf8"));
  const req = schema.$defs.JobRequest;
  assert.equal(req.properties.per_edit.type, "boolean");
  assert.equal((req.required || []).includes("per_edit"), false, "optional: classic bodies omit it");
});
