// CLI entry behind bin/intent.js. Every path exits 0 except the deliberate concerns wake (exit 2).
import { log, errFields } from "./log.js";

const SYNC_WATCHDOG_MS = 8000;

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    let size = 0;
    const done = () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const t = setTimeout(done, timeoutMs);
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size <= 16 * 1024 * 1024) chunks.push(c);
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

async function readPayload() {
  try {
    const p = JSON.parse(await readStdin());
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function finish(code, stdout = "", stderr = "") {
  const exit = () => process.exit(code);
  const writeErr = () => (stderr ? process.stderr.write(stderr, exit) : exit());
  if (stdout) process.stdout.write(stdout, writeErr);
  else writeErr();
}

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v || null;
}

export async function main(argv) {
  const args = [...argv];
  const data = takeFlag(args, "--data");
  if (data && !data.includes("${")) process.env.CLAUDE_PLUGIN_DATA = data;
  const cmd = args[0] || "";
  const startedAt = Date.now();
  const sync = ["session-start", "prompt", "post-tool"].includes(cmd);
  if (sync) setTimeout(() => process.exit(0), SYNC_WATCHDOG_MS).unref();

  try {
    const hooks = await import("./hooks.js");
    const claude = await import("./claude.js");
    switch (cmd) {
      case "session-start": {
        const r = await hooks.sessionStart(await readPayload());
        return finish(0, claude.contextOutput("SessionStart", r));
      }
      case "prompt": {
        const r = await hooks.prompt(await readPayload());
        return finish(0, claude.contextOutput("UserPromptSubmit", r));
      }
      case "post-tool": {
        hooks.postTool(await readPayload());
        return finish(0);
      }
      case "stop": {
        const payload = await readPayload();
        const interactive = process.env.CLAUDE_CODE_ENTRYPOINT === "cli";
        const r = await hooks.stop(payload, { interactive, startedAt });
        if (r && r.exit === 2 && r.text) {
          const w = claude.wakeOutput(r);
          log("stop.wake", {});
          return finish(2, w.stdout, w.stderr);
        }
        return finish(0);
      }
      case "stop-detached": {
        await hooks.stopDetached(args[1]);
        return finish(0);
      }
      case "finish": {
        const { runFinisher } = await import("./runner.js");
        if (/^[0-9a-f]{32}$/.test(args[1] || "")) await runFinisher(args[1]);
        return finish(0);
      }
      case "connect-poll": {
        const { runPoller } = await import("./connect.js");
        await runPoller();
        return finish(0);
      }
      case "off":
      case "on":
      case "status": {
        const { command } = await import("./commands.js");
        try {
          return finish(0, command(cmd) + "\n");
        } catch (e) {
          // Typically the Codex sandbox: the plugin's data folder is outside the writable roots.
          // Say so and fail, so the agent can ask to rerun it with approval.
          log("error", { cmd, ...errFields(e) });
          const what = cmd === "off" ? "turn checks off" : cmd === "on" ? "turn checks on" : "read the settings";
          const alt = cmd === "off" ? ", or set INTENT_DISABLED=1 in the environment to stop all uploads" : "";
          return finish(1, "", `Intent Check: could not ${what}: the plugin's data folder is not writable here (${String((e && e.code) || "error")}). Rerun this command with permission to write outside the sandbox${alt}.\n`);
        }
      }
      case "check": {
        const { checkCommand } = await import("./queue.js");
        return finish(0, checkCommand(args.slice(1)) + "\n");
      }
      default:
        return finish(0);
    }
  } catch (e) {
    log("error", { cmd, ...errFields(e) });
    return finish(0, cmd === "check" ? "Intent Check: could not queue the review.\n" : "");
  }
}
