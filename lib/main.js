// CLI entry behind bin/intent.js. Every path exits 0 except the deliberate concerns wake (exit 2).
import { log, errFields } from "./log.js";
import { isInteractiveEntrypoint } from "./config.js";

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
    if (p && typeof p === "object" && process.env.INTENT_DEBUG === "1") {
      log("hook.in", { hook: p.hook_event_name, tool: p.tool_name, session: String(p.session_id || "").slice(0, 8), turn: String(p.turn_id || p.prompt_id || "").slice(0, 8), active: p.stop_hook_active });
    }
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

// Log what was handed to the host (sizes and kinds only, never the text), so delivery can be traced.
function injected(event, stdout, payload, host) {
  if (stdout) {
    const KINDS = { concerns: /Intent Check: \d+ concerns?\b/, no_concerns: /Intent Check: no concerns/, connect: /Intent Check: connect your account/,
      connected: /Intent Check: connected\./, consent: /Intent Check is on\./, paused: /checks are paused/, limit: /limit was reached|too many checks/ };
    const kinds = Object.keys(KINDS).filter((k) => KINDS[k].test(stdout));
    log("hook.output", { hook: event, host, bytes: Buffer.byteLength(stdout), kinds, session: String(payload.session_id || "").slice(0, 8) });
  }
  return stdout;
}

export async function main(argv) {
  const args = [...argv];
  const data = takeFlag(args, "--data");
  // Codex runs hooks/codex-hooks.json, which passes --host codex. PLUGIN_ROOT is set only by
  // Codex; CLAUDECODE is not a signal because it leaks into Codex started from Claude Code.
  const host = takeFlag(args, "--host") === "codex" || process.env.PLUGIN_ROOT ? "codex" : "claude-code";
  if (data && !data.includes("${")) process.env.CLAUDE_PLUGIN_DATA = data;
  const cmd = args[0] || "";
  const startedAt = Date.now();
  const sync = ["session-start", "prompt", "post-tool"].includes(cmd);
  if (sync) setTimeout(() => process.exit(0), SYNC_WATCHDOG_MS).unref();
  // Codex's Stop is sync with a 30 s timeout: never get near it.
  if (cmd === "stop" && host === "codex") setTimeout(() => process.exit(0), 25000).unref();

  try {
    const hooks = await import("./hooks.js");
    const out = host === "codex" ? await import("./codex.js") : await import("./claude.js");
    switch (cmd) {
      case "session-start": {
        const payload = await readPayload();
        const r = await hooks.sessionStart(payload, { host });
        return finish(0, injected("SessionStart", out.contextOutput("SessionStart", r), payload, host));
      }
      case "prompt": {
        const payload = await readPayload();
        const r = await hooks.prompt(payload, { host });
        return finish(0, injected("UserPromptSubmit", out.contextOutput("UserPromptSubmit", r), payload, host));
      }
      case "post-tool": {
        hooks.postTool(await readPayload());
        return finish(0);
      }
      case "stop": {
        const payload = await readPayload();
        if (host === "codex") {
          const r = await hooks.stopCodex(payload);
          if (r.exit === 2 && r.text) {
            log("hook.output", { hook: "Stop", host, bytes: Buffer.byteLength(r.text), kinds: ["concern"], exit: 2 });
            const w = out.stopDeliveryOutput(r.text);
            return finish(2, w.stdout, w.stderr);
          }
          return finish(0);
        }
        const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "";
        const interactive = isInteractiveEntrypoint(entrypoint);
        log("stop.entrypoint", { entrypoint: entrypoint || "(unset)", interactive });
        const r = await hooks.stop(payload, { interactive, startedAt });
        if (r && r.exit === 2 && r.text) {
          const w = out.wakeOutput(r);
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
