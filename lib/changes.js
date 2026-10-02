// Work out which files changed this turn and their diffs. With git: files dirty now that also
// differ from the prompt-time baseline (security-guidance "v2 review set", Apache-2.0, see
// NOTICE), plus the paths Edit/Write touched. Without git: the touched paths and the
// structuredPatch hunks Claude Code reported for them.
import fs from "node:fs";
import path from "node:path";
import * as g from "./git.js";
import { classifyPath, includeFile, isTestPath, extOf } from "./filter.js";
import { neverUpload } from "./redact.js";
import { C } from "./config.js";

export const MAX_FILE_BYTES = 1024 * 1024;

// The same 3-changed-lines trigger buildRequest applies to edit jobs (contract/constants.json),
// reused here so the skipped-files note (T1) fires on the same threshold, not a separate one.
const SKIP_NOTE_MIN_LINES = C.limits.min_changed_lines;

// Path-only reason buckets for the skipped-files note. Deliberately separate from filter.js's
// own UI_DIRS/VENDOR_DIRS/CONFIG_BASENAME (which T2 may change): these are for explaining a skip
// to the user, not for the yes/no/needs-content decision itself, which stays on classifyPath/includeFile.
const VENDOR_DIR_RE = /(^|\/)(?:node_modules|vendor|dist|build|third_party|\.git|\.intent|\.venv|venv|__pycache__|\.next|\.nuxt|__generated__|bower_components)(\/|$)/;
const CONFIG_BASENAME_RE = /^(?:[\w.-]+\.config\.[cm]?[jt]s|\.[\w-]+rc\.[cm]?js|gulpfile\.[cm]?js|gruntfile\.[cm]?js|setup\.py|conftest\.py|manage\.py)$/i;
const STYLE_MARKUP_EXT = new Set([".css", ".scss", ".less", ".html", ".jsx", ".tsx", ".vue", ".svelte"]);

function inVendorDir(p) {
  return VENDOR_DIR_RE.test(p);
}

// A path-only check for whether a file classifyPath excludes ("no") is still worth reading and
// diffing, just to explain the skip: test/vendor/config/style-markup paths are cheap to spot
// without opening the file. Anything else classifyPath calls "no" (unsupported extensions,
// .min.js, lockfiles, images, docs, …) is left untouched, exactly as before this feature.
function likelySkipCandidate(p) {
  return isTestPath(p) || inVendorDir(p) || CONFIG_BASENAME_RE.test(p.split("/").pop() || "") || STYLE_MARKUP_EXT.has(extOf(p));
}

// Reason category for a file excluded from checking (test, config, vendor, styling or markup,
// other), shown in the skipped-files note. cls is classifyPath's verdict ("no" or "needs-content"
// without qualifying content, e.g. a presentational component).
function skipReason(rel, cls) {
  if (isTestPath(rel)) return "test";
  if (inVendorDir(rel)) return "vendor";
  if (CONFIG_BASENAME_RE.test(rel.split("/").pop() || "")) return "config";
  if (STYLE_MARKUP_EXT.has(extOf(rel)) || cls === "needs-content") return "styling or markup";
  return "other";
}

export function countChangedLines(diff) {
  if (!diff) return 0;
  let n = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    if (inHunk && (line[0] === "+" || line[0] === "-")) n++;
  }
  return n;
}

// New-file ranges [start, end] (1-based) from @@ headers.
export function hunkRanges(diff) {
  const out = [];
  if (!diff) return out;
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(diff))) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    out.push([Math.max(1, start), Math.max(start, start + len - 1)]);
  }
  return out;
}

export function newFileDiff(rel, content) {
  const lines = content.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n") + "\n";
}

export function patchesToDiff(rel, patches) {
  if (!Array.isArray(patches) || !patches.length) return null;
  let out = `--- a/${rel}\n+++ b/${rel}\n`;
  for (const h of patches) {
    if (!h || !Array.isArray(h.lines)) continue;
    out += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` + h.lines.join("\n") + "\n";
  }
  return out;
}

export function toRel(root, p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  let rel;
  try {
    rel = path.relative(fs.realpathSync(root), fs.existsSync(abs) ? fs.realpathSync(abs) : path.resolve(abs));
  } catch {
    rel = path.relative(root, abs);
  }
  rel = rel.split(path.sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return rel;
}

function readSmallFile(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null; // binary
    return buf;
  } catch {
    return null;
  }
}

// Returns { root, git: bool, files: [{ rel, abs, buf, content, diff, changed }] } in edit order.
export async function collectChanges(snap, cwd) {
  const baseline = snap.baseline || null;
  const repo = (baseline && baseline.repo) || (await g.toplevel(cwd));
  const touched = Array.isArray(snap.touched) ? snap.touched : [];
  if (repo) {
    const st = await g.statusPorcelain(repo);
    if (st) return collectGit(repo, st, baseline, touched);
  }
  return collectNoGit(cwd, touched, snap.patches || {});
}

async function collectGit(repo, st, baseline, touched) {
  const untrackedAt = (baseline && baseline.untracked) || {};
  const newUntracked = new Set();
  for (const p of st.untracked) {
    let same = false;
    if (untrackedAt[p] !== undefined) {
      try { same = fs.statSync(path.join(repo, p)).mtimeMs === untrackedAt[p]; } catch { same = false; }
    }
    if (!same) newUntracked.add(p);
  }
  const touchedRel = [];
  const elsewhere = [];
  for (const t of touched) {
    const r = toRel(repo, t);
    if (!r || WORKTREE_DIR.test(r)) elsewhere.push(t);
    else if (!touchedRel.includes(r)) touchedRel.push(r);
  }

  let candidates;
  let diffBase = "HEAD";
  if (baseline && baseline.sha) {
    const dirty = new Set([...st.tracked, ...newUntracked]);
    const head = await g.revParseHead(repo);
    if (baseline.head && head && baseline.head !== head && (await g.isAncestor(repo, baseline.head, head))) {
      const committed = await g.nameOnly(repo, baseline.head, true);
      for (const p of committed || []) dirty.add(p);
      diffBase = baseline.head;
    }
    const since = await g.nameOnly(repo, baseline.sha);
    const review = since ? [...dirty].filter((p) => since.has(p) || newUntracked.has(p)) : [...dirty];
    candidates = [...touchedRel, ...review.sort().filter((p) => !touchedRel.includes(p))];
  } else {
    // No baseline (no commits yet, or the prompt hook never ran): only what the agent touched,
    // so the user's own uncommitted work is never swept in.
    candidates = touchedRel;
  }

  candidates = candidates.filter((p) => !st.deleted.has(p) && !neverUpload(p) && (classifyPath(p) !== "no" || likelySkipCandidate(p)));
  const ign = await g.ignored(repo, candidates);
  const files = [];
  const skipped = [];
  const contentBase = (baseline && baseline.sha) || diffBase;
  for (const rel of candidates) {
    if (ign.has(rel)) continue;
    const cls = classifyPath(rel);
    const abs = path.join(repo, rel);
    const buf = readSmallFile(abs);
    if (!buf) continue;
    const content = buf.toString("utf8");
    const included = cls !== "no" && includeFile(rel, content);
    let diff;
    const inBase = !newUntracked.has(rel) && (await g.existsAt(repo, contentBase, rel));
    if (!inBase) diff = newFileDiff(rel, content);
    else {
      diff = await g.diffFile(repo, contentBase, rel);
      if (diff === null && contentBase !== diffBase) diff = await g.diffFile(repo, diffBase, rel);
    }
    const changed = countChangedLines(diff);
    if (!changed) continue;
    if (!included) {
      if (changed >= SKIP_NOTE_MIN_LINES) skipped.push({ rel, reason: skipReason(rel, cls) });
      continue;
    }
    files.push({ rel, abs, buf, content, diff, changed });
  }
  const wt = await collectWorktrees(repo, elsewhere);
  for (const f of wt.files) if (!files.some((x) => x.rel === f.rel)) files.push(f);
  for (const s of wt.skipped) if (!skipped.some((x) => x.rel === s.rel)) skipped.push(s);
  return { root: repo, git: true, files, renamed: st.renamed || [], deleted: [...st.deleted], skipped };
}

// Claude Code puts isolated subagents in <repo>/.claude/worktrees/<name>. Their edits are reviewed
// under the repo-relative path (what the user will merge), diffed against that worktree's HEAD.
const WORKTREE_DIR = /(^|\/)\.claude\/worktrees\//;

async function collectWorktrees(repo, paths) {
  const files = [];
  const skipped = [];
  if (!paths.length) return { files, skipped };
  const common = await g.commonDir(repo);
  if (!common) return { files, skipped };
  const tops = new Map();
  for (const p of paths) {
    if (!path.isAbsolute(p)) continue;
    const dir = path.dirname(p);
    let top = tops.get(dir);
    if (top === undefined) {
      top = await g.toplevel(dir);
      if (top && (top === repo || (await g.commonDir(top)) !== common)) top = null;
      tops.set(dir, top);
    }
    if (!top) continue;
    const rel = toRel(top, p);
    if (!rel || neverUpload(rel) || files.some((f) => f.rel === rel) || skipped.some((f) => f.rel === rel)) continue;
    const cls = classifyPath(rel);
    if (cls === "no" && !likelySkipCandidate(rel)) continue;
    if ((await g.ignored(top, [rel])).size) continue;
    const buf = readSmallFile(p);
    if (!buf) continue;
    const content = buf.toString("utf8");
    const included = cls !== "no" && includeFile(rel, content);
    const diff = (await g.existsAt(top, "HEAD", rel)) ? await g.diffFile(top, "HEAD", rel) : newFileDiff(rel, content);
    const changed = countChangedLines(diff);
    if (!changed) continue;
    if (!included) {
      if (changed >= SKIP_NOTE_MIN_LINES) skipped.push({ rel, reason: skipReason(rel, cls) });
      continue;
    }
    files.push({ rel, abs: p, buf, content, diff, changed, worktree: top });
  }
  return { files, skipped };
}

function collectNoGit(cwd, touched, patches) {
  const files = [];
  const skipped = [];
  const seen = new Set();
  for (const t of touched) {
    const rel = toRel(cwd, t);
    if (!rel || seen.has(rel) || neverUpload(rel)) continue;
    seen.add(rel);
    const cls = classifyPath(rel);
    const abs = path.join(cwd, rel);
    const buf = readSmallFile(abs);
    if (!buf) continue;
    const content = buf.toString("utf8");
    const included = cls !== "no" && includeFile(rel, content);
    const diff = patchesToDiff(rel, patches[t] || patches[abs]);
    const changed = diff ? countChangedLines(diff) : content.split("\n").filter((l, i, a) => i < a.length - 1 || l).length;
    if (!changed) continue;
    if (!included) {
      if (changed >= SKIP_NOTE_MIN_LINES) skipped.push({ rel, reason: skipReason(rel, cls) });
      continue;
    }
    files.push({ rel, abs, buf, content, diff, changed });
  }
  return { root: cwd, git: false, files, renamed: [], deleted: [], skipped };
}
