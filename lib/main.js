// Explicit plugin commands only. No stdin, session capture, hooks or detached workers.
import { apiUrl, consoleUrl } from "./config.js";

export async function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return args.splice(i, 2)[1];
  };
  const data = take("--data");
  const host = take("--host") === "codex" ? "codex" : "claude-code";
  if (data && !data.includes("${")) process.env.CLAUDE_PLUGIN_DATA = data;
  const cmd = args.shift();
  if (!cmd || cmd === "--help") return "Usage: intent scan [file or folder] [fast|balanced|full]\n       intent scan collect [task-id]\n       intent doctor\nSign in: intent-check login";
  if (!["scan", "doctor"].includes(cmd)) throw new Error(`Unknown command: ${cmd}`);
  apiUrl();
  consoleUrl();
  if (cmd === "doctor") {
    if (args.length) throw new Error("doctor takes no arguments");
    return (await import("./commands.js")).doctorCommand({ host });
  }
  const scan = await import("./scan.js");
  if (args[0] === "collect") {
    if (args.length > 2) throw new Error("Use: scan collect [task-id]");
    return scan.collectCommand(args[1]);
  }
  return scan.scanCommand(args, { host });
}
