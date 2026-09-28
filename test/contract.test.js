import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "contract");

test("contract copy matches CONTRACT.sha256 (same hash as the prover repo)", () => {
  execFileSync("node", [join(dir, "hash.mjs")], { stdio: "pipe" });
});

test("api key redaction regex catches an example key", () => {
  const c = JSON.parse(readFileSync(join(dir, "constants.json"), "utf8"));
  const key = JSON.parse(readFileSync(join(dir, "examples", "connect-approved.json"), "utf8")).api_key;
  assert.match(`INTENT_API_KEY=${key}`, new RegExp(c.api_key.redaction_regex));
});
