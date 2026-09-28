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

const L = C.limits;

export { clip };

// Full file up to 1,500 lines; beyond that the touched regions ±40 lines joined with "\n...\n".
const MAX_REGIONS = 200;

export function unitContent(content, diff) {
  const lines = content.split("\n");
  if (lines.length <= L.content_full_lines) return { content, truncated: false };
  const ctx = L.touched_context_lines;
  const ranges = hunkRanges(diff)
    .map(([a, b]) => [Math.max(1, a - ctx), Math.min(lines.length, b + ctx)])
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

// Prior artifacts from .intent/<rel>/. A cloned repo controls these files, so: regular files only
// (no symlinks), resolved path inside .intent/, at most 64 KB each, and redacted like everything else.
export function readPrior(root, rel) {
  const dir = unitDir(root, rel);
  if (!dir) return null;
  let base;
  try {
    const top = path.join(root, ".intent");
    if (fs.lstatSync(top).isSymbolicLink()) return null;
    base = fs.realpathSync(top) + path.sep;
  } catch {
    return null;
  }
  let redactions = 0;
  const read = (f) => {
    const file = path.join(dir, f);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > PRIOR_MAX_BYTES) return null;
      if (!fs.realpathSync(file).startsWith(base)) return null;
      const r = redact(fs.readFileSync(file, "utf8"));
      redactions += r.count;
      return r.text;
    } catch {
      return null;
    }
  };
  const intent = read("INTENT.md");
  const spec = read("SPEC.k");
  const sem = read("SEMANTICS.k");
  if (intent === null && spec === null && sem === null) return null;
  let src = null;
  try {
    const m = JSON.parse(read("meta.json") || "null");
    if (m && /^[0-9a-f]{64}$/.test(m.source_sha256)) src = m.source_sha256;
  } catch { /* ignore */ }
  return { intent_md: intent, spec_k: spec, semantics_k: sem, source_sha256: src, redactions };
}

// Returns { request, sent: [{rel, sha256}], redactions, truncated } or null when nothing qualifies.
export function buildRequest({ files, root, snap, stop, sessionHash, turnId, host, hostVersion, mode = "edit" }) {
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
    if (units.length >= (mode === "repo" ? L.max_units_repo : L.max_units_edit)) { truncated = true; break; }
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
    sent.push({ rel: f.rel, sha256: hash, bytes: f.buf.length });
    changed += f.changed;
  }
  // The 3-changed-lines trigger applies to edits; review requests are explicit.
  if (!units.length || (mode === "edit" && changed < L.min_changed_lines)) return null;

  const prompts = (snap.prompts || []).slice(-L.max_prompts).map((p) => r(p, L.prompt_chars)).filter((p) => p !== null);
  let first = snap.first_prompt && !(snap.prompts || []).includes(snap.first_prompt) ? r(snap.first_prompt, L.prompt_chars) : null;
  if (first === "") first = null;
  const request = {
    contract_version: "1",
    mode,
    host,
    host_version: clip(hostVersion || "unknown", 40),
    plugin_version: clip(pluginVersion(), 40),
    os: osName(),
    session_id: sessionHash,
    turn_id: clip(String(turnId || "turn"), 128),
    permission_mode: typeof stop.permission_mode === "string" ? clip(stop.permission_mode, 40) : null,
    codex_modes: null,
    intent: {
      prompts,
      first_prompt: first,
      plan: snap.plan ? r(snap.plan, L.plan_chars) : null,
      todos: (snap.todos || []).slice(0, L.max_todos).map((t) => r(String(t), L.todo_chars)),
      agent_message: typeof stop.last_assistant_message === "string" ? r(stop.last_assistant_message, L.agent_message_chars) : null,
    },
    units,
    changed_lines: changed,
    truncated,
  };

  deepWellFormed(request);
  // Payload cap: drop units from the end until it fits.
  while (Buffer.byteLength(JSON.stringify(request)) > L.max_payload_bytes && request.units.length > 1) {
    request.units.pop();
    sent.pop();
    request.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(request)) > L.max_payload_bytes) return null;
  return { request, sent, redactions, truncated: request.truncated };
}

export function idempotencyKey(sessionHash, turnId, sent) {
  return sha256([sessionHash, turnId, ...sent.map((s) => `${s.rel}:${s.sha256}`)].join("\n"));
}
