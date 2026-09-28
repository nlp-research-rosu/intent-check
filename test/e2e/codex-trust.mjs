// Prints [hooks.state] entries that mark this plugin's Codex hooks as trusted, for an ISOLATED
// test CODEX_HOME only (never ~/.codex). Hash algorithm reproduced from codex-rs (research/03):
// sha256 over canonical JSON of {event_name, matcher?, hooks:[{type, command, timeout, async, ...}]}.
//   node test/e2e/codex-trust.mjs [plugin@marketplace] >> "$CODEX_HOME/config.toml"
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const id = process.argv[2] || "intent@intentcomputing";
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const snake = (s) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

export function hookHash(event, matcher, h) {
  const handler = { type: "command", command: h.command, timeout: h.timeout ?? 600, async: !!h.async };
  if (h.statusMessage) handler.statusMessage = h.statusMessage;
  if (h.additionalContextLimit != null && h.additionalContextLimit !== 2500) handler.additionalContextLimit = h.additionalContextLimit;
  const o = { event_name: event, hooks: [handler] };
  if (matcher != null) o.matcher = matcher;
  return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(canon(o))).digest("hex");
}

export function trustEntries(pluginId = id, file = "hooks/codex-hooks.json") {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).hooks;
  const out = [];
  for (const [event, groups] of Object.entries(hooks)) {
    groups.forEach((g, gi) => g.hooks.forEach((h, hi) => {
      out.push(`[hooks.state."${pluginId}:${file}:${snake(event)}:${gi}:${hi}"]`, `trusted_hash = "${hookHash(snake(event), g.matcher ?? null, h)}"`, "");
    }));
  }
  return out.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) console.log(trustEntries());
