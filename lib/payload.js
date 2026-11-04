// Build a contract-v1 JobRequest from the turn's changes and captured intent.
// Everything that leaves the machine passes through redact() here.
import fs from "node:fs";
import path from "node:path";
import { C, pluginVersion, osName } from "./config.js";
import { redact, redactDiff } from "./redact.js";
import { languageOf } from "./filter.js";
import { hunkRanges } from "./changes.js";
import { sha256 } from "./fsutil.js";
import { unitDir } from "./intentdir.js";
import { clip, deepWellFormed } from "./text.js";
import { requirementContext, requirementText, reviewNotes } from "./requirements.js";

const L = C.limits;

export { clip };

// Full file up to 1,500 lines; beyond that the touched regions ±40 lines joined with "\n...\n".
const MAX_REGIONS = 200;

export function unitContent(content, diff) {
  const lines = content.split("\n");
  // A trailing newline leaves an empty last element; it is not a line of the file.
  const n = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
  if (n <= L.content_full_lines) return { content, truncated: false };
  const ctx = L.touched_context_lines;
  const ranges = hunkRanges(diff)
    // A deletion at EOF starts at n + 1 (zero-length range): keep it; a stale hunk further out: drop.
    .filter(([a]) => a <= n + 1)
    .map(([a, b]) => [Math.min(n, Math.max(1, a - ctx)), Math.min(n, b + ctx)])
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  if (!merged.length) merged.push([1, L.content_full_lines]);
  const kept = merged.slice(0, MAX_REGIONS);
  return {
    content: kept.map(([a, b]) => lines.slice(a - 1, b).join("\n")).join("\n...\n"),
    truncated: true,
    // Real 1-based inclusive line ranges of the regions, in order (contract UnitRequest.regions).
    regions: kept.map(([start, end]) => ({ start, end })),
  };
}

const PRIOR_MAX_BYTES = 64 * 1024;
// Requirements are read through the distributed CLI's enforced local schema.
export function readNotes(root) {
  return requirementText(requirementContext(root));
}

// Resolve current formal files through property indexes, never by sorting historical runs.
export function readPrior(root, rel) {
  if (!unitDir(root, rel) || !fs.existsSync(path.join(root, ".intent"))) return null;
  if (fs.lstatSync(path.join(root, ".intent")).isSymbolicLink()) return null;
  const top = path.join(root, ".intent"), base = fs.realpathSync(top) + path.sep;
  const ids = new Set(requirementContext(root, [rel]).requirements.map(r => r.id));
  const paths = new Set();
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(dir, entry.name), file = path.join(folder, "index.json");
      if (fs.existsSync(file)) {
        const index = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const [id, selection] of Object.entries(index.properties || {})) {
          if (ids.has(id)) for (const p of selection.specs || []) paths.add(p);
        }
      } else if (!fs.existsSync(path.join(folder, "requirements.json"))) walk(folder);
    }
  };
  walk(path.join(top, "source"));
  let redactions = 0;
  const groups = { spec_k: [], verification_k: [], semantics_k: [] };
  for (const p of [...paths].sort()) {
    if (typeof p !== "string" || !p.startsWith("source/") || !p.includes("/specs/") || p.split("/").some(s => !s || s === "." || s === "..")) continue;
    const file = path.join(top, p);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > PRIOR_MAX_BYTES || !fs.realpathSync(file).startsWith(base) || !p.endsWith(".k")) continue;
      const r = redact(fs.readFileSync(file, "utf8"));
      redactions += r.count;
      const name = path.basename(p).toLowerCase();
      groups[name.includes("verification") ? "verification_k" : name.includes("semantics") ? "semantics_k" : "spec_k"].push(r.text);
    } catch { /* missing current formal file */ }
  }
  if (!Object.values(groups).some(files => files.length)) return null;
  return { intent_md: null, ...Object.fromEntries(Object.entries(groups).map(([key, files]) => [key, files.length ? clip(files.join("\n\n"), PRIOR_MAX_BYTES) : null])), source_sha256: null, redactions };
}

// Returns { request, sent: [{rel, sha256}], redactions, truncated } or null when nothing qualifies.
export function buildRequest({ files, root, snap, stop, sessionHash, turnId, host, hostVersion, mode = "edit", codexModes = null, perEdit = false }) {
  let redactions = 0;
  const r = (s, n) => {
    if (typeof s !== "string") return null;
    // Redact the whole (bounded) text before clipping, so a secret is never cut in half first.
    const out = redact(clip(s, 200000) || "");
    redactions += out.count;
    return clip(out.text, n);
  };

  const units = [];
  const sent = [];
  let changed = 0;
  let truncated = false;
  for (const f of files) {
    if (units.length >= L.max_units_edit) { truncated = true; break; }
    if (units.length && changed + f.changed > L.changed_lines_cap) { truncated = true; continue; }
    // Redaction keeps line numbers, so regions can be cut after redacting the whole file.
    const rc = redact(f.content);
    const rd = f.diff ? redactDiff(f.diff, f.content) : { text: null, count: 0 };
    redactions += rc.count + rd.count;
    const { content, truncated: cut, regions } = unitContent(rc.text, f.diff);
    const hash = sha256(f.buf);
    const prior = readPrior(root, f.rel);
    if (prior) {
      redactions += prior.redactions;
      delete prior.redactions;
    }
    units.push({
      path: f.rel,
      language: languageOf(f.rel),
      sha256: hash,
      diff: rd.text,
      content,
      content_truncated: cut,
      ...(regions ? { regions } : {}),
      prior,
    });
    sent.push({ rel: f.rel, sha256: hash, bytes: f.buf.length, ...(f.worktree ? { abs: f.abs } : {}) });
    changed += f.changed;
  }
  // The 3-changed-lines trigger applies to edits; review requests are explicit.
  if (!units.length || (mode === "edit" && changed < L.min_changed_lines)) return null;

  const prompts = (snap.prompts || []).slice(-L.max_prompts).map((p) => r(p, L.prompt_chars)).filter((p) => p !== null);
  let first = snap.first_prompt && !(snap.prompts || []).includes(snap.first_prompt) ? r(snap.first_prompt, L.prompt_chars) : null;
  if (first === "") first = null;
  const context = requirementContext(root, units.map((u) => u.path));
  let notes = reviewNotes(context, units.map(u => u.path), L.notes_chars);
  const request = {
    contract_version: "1",
    mode,
    ...(perEdit ? { per_edit: true } : {}),
    host,
    host_version: clip(hostVersion || "unknown", 40),
    plugin_version: clip(pluginVersion(), 40),
    os: osName(),
    session_id: sessionHash,
    turn_id: clip(String(turnId || "turn"), 128),
    // Codex's hook permission_mode is only default/bypassPermissions; the real modes go in codex_modes.
    permission_mode: host !== "codex" && typeof stop.permission_mode === "string" ? clip(stop.permission_mode, 40) : null,
    codex_modes: host === "codex" ? codexModes || { approval_policy: null, sandbox: null, collaboration_mode: null } : null,
    intent: {
      prompts,
      first_prompt: first,
      plan: snap.plan ? r(snap.plan, L.plan_chars) : null,
      todos: (snap.todos || []).slice(0, L.max_todos).map((t) => r(String(t), L.todo_chars)),
      agent_message: typeof stop.last_assistant_message === "string" ? r(stop.last_assistant_message, L.agent_message_chars) : null,
      ...(notes.text ? { notes: notes.text } : {}),
    },
    units,
    changed_lines: changed,
    truncated: truncated || notes.binding.excluded.length > 0 || notes.binding.brief?.partial === true,
  };

  deepWellFormed(request);
  // Payload cap: drop units from the end until it fits.
  while (Buffer.byteLength(JSON.stringify(request)) > L.max_payload_bytes && request.units.length > 1) {
    request.units.pop();
    sent.pop();
    notes = reviewNotes(context, request.units.map(u => u.path), L.notes_chars);
    if (notes.text) request.intent.notes = notes.text;
    else delete request.intent.notes;
    request.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(request)) > L.max_payload_bytes) return null;
  return { request, sent, requirements: notes.binding, redactions: redactions + notes.redactions, truncated: request.truncated };
}

export function idempotencyKey(sessionHash, turnId, sent) {
  return sha256([sessionHash, turnId, ...sent.map((s) => `${s.rel}:${s.sha256}`)].join("\n"));
}
