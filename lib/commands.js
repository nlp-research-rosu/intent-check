// /intent:off, /intent:on and status. Output is shown to the user by the slash command.
import { setDisabled, disabledReason, apiKey, apiUrl, dataDir } from "./config.js";
import { readConnect } from "./connect.js";

export function command(cmd) {
  if (cmd === "off") {
    setDisabled(true);
    return "Intent Check is off. Nothing will be sent until it is turned back on (/intent:on in Claude Code, intent.js on in Codex).";
  }
  if (cmd === "on") {
    setDisabled(false);
    const env = disabledReason();
    if (env) return `Intent Check is on, but ${env}=1 is set in the environment, so nothing will be sent until it is removed.`;
    return apiKey().key ? "Intent Check is on." : "Intent Check is on. It will show a link to connect your account at your next prompt.";
  }
  const reason = disabledReason();
  const c = readConnect();
  return [
    `Intent Check: ${reason ? `off (${reason})` : "on"}`,
    `Account: ${apiKey().key ? "connected" : c && c.status === "pending" ? `waiting for approval at ${c.verification_url}` : "not connected"}`,
    `Service: ${apiUrl()}`,
    `Local state: ${dataDir()}`,
  ].join("\n");
}
