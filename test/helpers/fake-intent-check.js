#!/usr/bin/env node
// A stand-in for the real `intent-check` CLI (used through INTENT_CLI_PATH): `login` runs the device flow against
// INTENT_CONSOLE_URL and saves the key in credentials.json like the real one, printing the same JSON lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const say = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = process.argv[2];

if (arg === "--version") {
  say("intent-check " + JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  process.exit(0);
}
if (arg !== "login") { say({ status: "failure", message: "unsupported" }); process.exit(1); }

const api = new URL(process.env.INTENT_API_URL).origin;
const portal = new URL(process.env.INTENT_CONSOLE_URL).origin;
const post = async (body) => {
  const r = await fetch(`${portal}/api/cli-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`The login portal returned HTTP ${r.status}`);
  return r.json();
};

function save(key) {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "intent-check");
  const file = path.join(dir, "credentials.json");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let creds = { keys: {} };
  try { creds = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
  creds.keys[api] = key;
  const tmp = path.join(dir, `.credential-${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(creds), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

try {
  const c = await post({ action: "start" });
  say({ status: "pending", verification_url: `${portal}/connect/${c.user_code}`, user_code: c.user_code, expires_in: c.expires_in });
  const deadline = Date.now() + c.expires_in * 1000;
  while (Date.now() < deadline) {
    let r = { status: "pending" };
    try { r = await post({ action: "poll", device_code: c.device_code }); } catch { /* retried, like the real CLI */ }
    if (r.status === "approved" && r.api_key) { save(r.api_key); say({ status: "connected" }); process.exit(0); }
    if (["denied", "expired", "consumed", "failed"].includes(r.status)) { say({ status: r.status }); process.exit(1); }
    await sleep(Number(process.env.FAKE_CLI_POLL_MS) || 100);
  }
  say({ status: "expired" });
  process.exit(1);
} catch (e) {
  say({ status: "failure", message: e.message });
  process.exit(1);
}
