// Just enough JSON Schema (draft 2020-12 subset used by contract/job-v1.schema.json) to check
// that what the plugin sends matches the contract. Returns a list of error strings.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./env.js";

export const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, "contract", "job-v1.schema.json"), "utf8"));

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

export function validate(value, schema, at = "$", root = SCHEMA) {
  const errs = [];
  if (schema.$ref) return validate(value, root.$defs[schema.$ref.split("/").pop()], at, root);
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(value, s, at, root).length === 0).length;
    if (ok !== 1) errs.push(`${at}: matches ${ok} of oneOf`);
    return errs;
  }
  if ("const" in schema && value !== schema.const) errs.push(`${at}: expected const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) {
      errs.push(`${at}: type ${t}, want ${types.join("|")}`);
      return errs;
    }
  }
  if (typeof value === "string") {
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${at}[${i}]`, root)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${at}: missing ${r}`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(v, props[k], `${at}.${k}`, root));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
    }
  }
  return errs;
}

export function validateDef(value, def) {
  return validate(value, SCHEMA.$defs[def]);
}

export const DEEPSCAN = JSON.parse(fs.readFileSync(path.join(ROOT, "contract", "deepscan-v1.schema.json"), "utf8"));
export function validateDeepscan(value, def) {
  return validate(value, DEEPSCAN.$defs[def], "$", DEEPSCAN);
}
