// The distributed CLI is the single validator and mutation interface for structured requirements.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./fsutil.js";
import { redact } from "./redact.js";
import { clip } from "./text.js";

export const BRIEF = "# Project requirements\n\n## Purpose\n\n## Expected behavior\n\n## Constraints\n\n## Out of scope\n\n## Open questions\n";

export function requirementContext(root, paths = []) {
  const base = path.join(root, ".intent");
  if (!fs.existsSync(base)) return { schema_version: 1, brief: null, requirements: [] };
  try {
    const output = execFileSync("intent-check", ["--project", root, "requirements", "context", ...paths.flatMap((p) => ["--path", p])], {
      encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const context = JSON.parse(output);
    if (context.schema_version !== 1 || !Array.isArray(context.requirements)) throw new Error("Invalid requirements context");
    return context;
  } catch (cause) {
    const missing = cause.code === "ENOENT" || /unrecognized subcommand.*requirements/.test(String(cause.stderr));
    throw Object.assign(new Error(missing
      ? "Intent Check: review did not start. Install the matching Intent Check CLI with the requirements context command and ensure it is first on PATH; verify intent-check requirements context --help."
      : "Intent Check: review did not start because local requirements could not be validated. Run intent-check requirements context in the project to inspect the error; repair the requirements or install the matching CLI."), { code: "requirements_context" });
  }
}

export function requirementText(context) {
  return [context.brief, context.requirements.length ? "Structured requirements:\n" + JSON.stringify(context.requirements) : null].filter(Boolean).join("\n\n") || null;
}

// Sorted object keys match serde_json's canonical Value serialization, including nested targets.
export function recordHash(record) {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
  return sha256(JSON.stringify(sorted(record)));
}

export function contextBinding(context) {
  return { version: 1, kind: "consumed_context", brief: context.brief ? { source_sha256: sha256(context.brief) } : null,
    records: context.requirements.map(r => ({ id: r.id, record_sha256: recordHash(r) })), excluded: [] };
}

// Only whole structured records are submitted. A clipped brief is explicitly a fragment;
// its source digest detects edits, while submitted_sha256 identifies only the consumed bytes.
export function reviewNotes(context, paths, limit) {
  const scoped = { ...context, requirements: context.requirements.filter(r => r.targets.some(t => paths.includes(t.path))) };
  const binding = contextBinding({ brief: null, requirements: [] });
  let text = "", redactions = 0;
  if (scoped.brief) {
    const r = redact(scoped.brief);
    redactions += r.count;
    text = clip(r.text, limit) || "";
    binding.brief = { source_sha256: sha256(scoped.brief), submitted_sha256: sha256(text), partial: text !== r.text };
  }
  for (const record of scoped.requirements) {
    const r = redact(JSON.stringify(record));
    const part = `${text ? "\n\n" : ""}Structured requirement:\n${r.text}`;
    if (text.length + part.length > limit) { binding.excluded.push({ id: record.id, reason: "context_limit" }); continue; }
    text += part;
    redactions += r.count;
    binding.records.push({ id: record.id, record_sha256: recordHash(record), submitted_sha256: sha256(r.text) });
  }
  return { text: text || null, binding, redactions };
}
