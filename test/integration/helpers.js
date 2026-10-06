// Shared by the integration tests: find a CLI on PATH (Windows .cmd shims included), run it with a
// clean throwaway environment, and kill its whole process tree on timeout.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const WIN = process.platform === "win32";

export function findCli(name) {
  // CI resolves the CLI before it trims PATH for a variant, and passes it here.
  const pinned = process.env[`INTENT_IT_${name.toUpperCase()}`];
  if (pinned) return pinned;
  const r = spawnSync(WIN ? "where" : "which", [name], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const hits = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // `where` lists the extensionless npm shim first; the .cmd/.exe next to it is what spawns.
  return (WIN ? hits.find((h) => /\.(exe|cmd)$/i.test(h)) : hits[0]) || null;
}

// The parent's environment minus anything that could point the CLI at a real account or plugin
// state, plus `extra`.
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "CLAUDE_CODE_GIT_BASH_PATH") continue; // where Claude Code finds Git Bash on Windows
    if (/^(INTENT_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_)/i.test(k) || k === "DO_NOT_TRACK") delete env[k];
  }
  return { ...env, ...extra };
}

const q = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export function killTree(child) {
  try {
    if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else process.kill(-child.pid, "SIGKILL");
  } catch { /* already gone */ }
}

// Resolves { code, stdout, stderr, timedOut }. A .cmd shim needs a shell on Windows.
export function runCli(bin, args, { env, cwd, timeoutMs = 55000, input = "" } = {}) {
  return new Promise((resolve) => {
    const useShell = WIN && /\.cmd$/i.test(bin);
    const child = useShell
      ? spawn(q(bin) + " " + args.map(q).join(" "), { env, cwd, shell: true, windowsHide: true })
      : spawn(bin, args, { env, cwd, detached: !WIN, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export const basename = (p) => path.basename(p);
