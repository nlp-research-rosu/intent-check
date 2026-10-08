// Codex specifics (verified live on Codex CLI 0.147 and 0.158, research/03):
// - Hooks run in shell form; there is no asyncRewake and Codex never starts a turn from a hook, so
//   the Stop hook is sync: it submits, hands polling to a detached process and exits quickly.
// - SessionStart / UserPromptSubmit context goes in hookSpecificOutput.additionalContext; the TUI
//   shows it to the user too, so user lines and agent text share that one field.
// - A sync Stop exit 2 turns stderr into a continuation prompt (used to deliver finished concerns).
// - The hook's permission_mode is only default/bypassPermissions; the real approval, sandbox and
//   plan mode come from the transcript's latest turn_context line.
import fs from "node:fs";
import path from "node:path";

export function contextOutput(eventName, { user, context }) {
  const parts = [];
  if (user) parts.push(user);
  if (context) for (const c of context.split("\n\n")) if (c && !(user || "").split("\n").includes(c)) parts.push(c);
  const text = parts.join("\n\n").trim();
  return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text.slice(0, 9000) } }) + "\n" : "";
}

export function stopDeliveryOutput(text) {
  return { stdout: "", stderr: text.slice(0, 9500) + "\n", code: 2 };
}

// Paths from an apply_patch command: Add/Update/Delete File and Move to. Relative paths are
// resolved against the hook's cwd. Deleted files are left to git status.
export function applyPatchPaths(command, cwd) {
  if (typeof command !== "string") return [];
  const out = [];
  for (const m of command.matchAll(/^\*\*\* (Add File|Update File|Move to): (.+?)\r?$/gm)) {
    const p = m[2].trim();
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
    if (!out.includes(abs)) out.push(abs);
  }
  // A moved file's old path is not a file any more.
  for (const m of command.matchAll(/^\*\*\* Update File: (.+?)\r?\n\*\*\* Move to: /gm)) {
    const old = path.isAbsolute(m[1].trim()) ? m[1].trim() : path.resolve(cwd || process.cwd(), m[1].trim());
    const i = out.indexOf(old);
    if (i !== -1) out.splice(i, 1);
  }
  return out;
}

// Latest turn_context in a Codex rollout (JSONL). Reads the tail first, the whole file if needed.
export function readTurnContext(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      for (const len of [Math.min(size, 256 * 1024), Math.min(size, 8 * 1024 * 1024)]) {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString("utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"turn_context"')) continue;
          try {
            const o = JSON.parse(lines[i]);
            if (o && o.type === "turn_context" && o.payload) return o.payload;
          } catch { /* partial first line of the window */ }
        }
        if (len === size) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* no transcript */ }
  return null;
}

// Contract CodexModes from a turn_context payload.
export function codexModes(tc) {
  const str = (v) => (typeof v === "string" ? v.slice(0, 64) : null);
  if (!tc) return { approval_policy: null, sandbox: null, collaboration_mode: null };
  return {
    approval_policy: str(tc.approval_policy),
    sandbox: str(tc.sandbox_policy && tc.sandbox_policy.type),
    collaboration_mode: str(tc.collaboration_mode && tc.collaboration_mode.mode),
  };
}

// Fix directly only when Codex runs without approvals, can write, and is not in plan mode.
// Returned as the Claude-style permission mode the renderer understands.
export function fixModeFor(modes) {
  const direct = modes.approval_policy === "never" && modes.sandbox && modes.sandbox !== "read-only" && modes.collaboration_mode !== "plan";
  return direct ? "bypassPermissions" : "default";
}
