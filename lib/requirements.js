// Internal request collection. Structured mutations belong to the CLI; agents read files directly.
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./fsutil.js";
import { redact } from "./redact.js";
import { clip } from "./text.js";
import { isProjectId } from "./project-id.js";

export const BRIEF = "# Project requirements\n\n## Purpose\n\n## Expected behavior\n\n## Constraints\n\n## Out of scope\n\n## Open questions\n";

export function requirementContext(root, paths = []) {
  const base = path.join(root, ".intent");
  if (!fs.existsSync(base)) return { schema_version: 1, brief: null, requirements: [] };
  try {
    if (fs.lstatSync(base).isSymbolicLink()) throw new Error(".intent must be a real directory");
    const text = file => {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Requirements must be regular files of at most 1 MiB: ${file}`);
      return fs.readFileSync(file, "utf8");
    };
    const requirements = [], ids = new Set();
    const read = (file, local) => {
      const doc = JSON.parse(text(file));
      if (doc.schema_version !== 1 || !Array.isArray(doc.requirements) || Object.keys(doc).some(k => !["schema_version", "requirements"].includes(k))) throw new Error(`Invalid requirements: ${file}`);
      for (const r of doc.requirements) {
        if (!isProjectId(r.id) || ids.has(r.id) || typeof r.statement !== "string" || !r.statement.trim() || !Array.isArray(r.targets) || !r.targets.length || Object.keys(r).some(k => !["id", "statement", "targets", "reason"].includes(k))) throw new Error(`Invalid requirement: ${file}`);
        const seen = new Set();
        for (const t of r.targets) {
          if (typeof t.path !== "string" || t.path.includes("\\") || t.path.includes(":") || t.path.split("/").some(p => !p || p === "." || p === "..") || [".intent", ".git"].includes(t.path.split("/")[0]) || /[\x00-\x1f]/.test(t.path) || (t.symbol !== undefined && (typeof t.symbol !== "string" || !t.symbol.trim())) || Object.keys(t).some(k => !["path", "symbol"].includes(k)) || seen.has(JSON.stringify(t))) throw new Error(`Invalid target: ${file}`);
          seen.add(JSON.stringify(t));
        }
        const scope = r.targets.every(t => t.path === r.targets[0].path) ? r.targets[0].path : null;
        if (scope !== local) throw new Error(`Requirement placement does not match targets: ${file}`);
        ids.add(r.id);
        if (!paths.length || r.targets.some(t => paths.includes(t.path))) requirements.push(r);
      }
    };
    const walk = dir => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory()) continue;
        const folder = path.join(dir, e.name), file = path.join(folder, "requirements.json");
        if (fs.existsSync(file)) read(file, path.relative(path.join(base, "source"), folder).split(path.sep).join("/"));
        else if (!fs.existsSync(path.join(folder, "index.json"))) walk(folder);
      }
    };
    const global = path.join(base, "source", "requirements.json");
    if (fs.existsSync(global)) read(global, null);
    walk(path.join(base, "source"));
    const brief = path.join(base, "REQUIREMENTS.md");
    return { schema_version: 1, brief: fs.existsSync(brief) ? text(brief) : null, requirements };
  } catch (cause) {
    throw Object.assign(new Error(`Intent Check: review did not start because local requirements could not be validated: ${cause.message}`), { code: "requirements_context" });
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
