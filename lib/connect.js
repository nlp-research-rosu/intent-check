// Hook sign-in is a small adapter to the global CLI. The CLI owns the device flow and credentials.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { apiKey, apiUrl, consoleUrl, credentialsFile, credentialsProblem, disabledReason } from "./config.js";
import { readJson, writeJsonAtomic, withLock, isPidAlive, sha256, sleep } from "./fsutil.js";
import { isOwnLink } from "./api.js";

const RETRY_MS = 30000;
const SETUP = "Intent Check needs the global intent-check CLI. Use the onboarding skill to install it, then continue; nothing is being checked yet.";

function output(file) {
  try {
    if (fs.statSync(file).size > 16384) return [];
    return fs.readFileSync(file, "utf8").split("\n").slice(0, -1).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function status(state, file) {
  if (!state) return { status: "none" };
  if (state.error) return { status: state.error === "ENOENT" ? "missing" : "failed" };
  const lines = output(file);
  const last = lines.at(-1);
  if (last && ["denied", "expired", "consumed", "failed", "failure"].includes(last.status)) return { status: last.status };
  const first = lines[0];
  if (first?.status === "pending" && /^[A-Z]{4}-[A-Z]{4}$/.test(first.user_code)
      && isOwnLink(first.verification_url) && first.verification_url.endsWith(`/connect/${first.user_code}`)
      && Number.isInteger(first.expires_in) && first.expires_in >= 1 && first.expires_in <= 900) {
    if (Date.now() < state.created_at + first.expires_in * 1000 && isPidAlive(state.pid)) {
      return { status: "pending", url: first.verification_url };
    }
    return { status: "expired" };
  }
  return { status: isPidAlive(state.pid) && Date.now() - state.created_at < 900000 ? "starting" : "failed" };
}

// Shared per service, not per host: concurrent Claude/Codex sessions reuse the same login process.
export async function connection({ waitMs = 0 } = {}) {
  if (disabledReason()) return { status: "off" };
  const key = apiKey();
  if (key.source === "env") return { status: "connected" };
  const dir = path.dirname(credentialsFile());
  const id = sha256(`${new URL(apiUrl()).origin}\n${new URL(consoleUrl()).origin}`).slice(0, 32);
  const file = path.join(dir, `login-${id}.json`);
  const out = path.join(dir, `login-${id}.out`);
  const lock = `${file}.lock`;
  if (key.key) {
    if (!fs.existsSync(file)) return { status: "connected" };
    const announce = withLock(lock, () => {
      const state = readJson(file);
      if (!state || state.announced) return false;
      writeJsonAtomic(file, { ...state, announced: true }, 0o600);
      return true;
    });
    return { status: "connected", announce };
  }
  if (credentialsProblem()) return { status: "failed", text: "Intent Check could not read the saved credential. Run /intent:doctor to check its permissions and format." };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const started = withLock(lock, () => {
    if (apiKey().key) return false;
    const previous = readJson(file);
    const current = status(previous, out);
    if (previous && (isPidAlive(previous.pid) || (current.status === "denied" && !previous.announced) || Date.now() - previous.created_at < RETRY_MS)) return false;
    const created = Date.now();
    const fd = fs.openSync(out, "w", 0o600);
    let child;
    try {
      child = spawn("intent-check", ["login"], {
        detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
        env: { ...process.env, INTENT_API_URL: apiUrl(), INTENT_CONSOLE_URL: consoleUrl() },
      });
      child.on("error", (error) => {
        try {
          withLock(lock, () => {
            const state = readJson(file);
            if (state?.created_at === created) writeJsonAtomic(file, { ...state, error: error.code || "spawn" }, 0o600);
          });
        } catch { /* another hook reports a failed attempt */ }
      });
      child.unref();
      writeJsonAtomic(file, { created_at: created, pid: child.pid || null }, 0o600);
    } finally { fs.closeSync(fd); }
    return true;
  });
  if (started) await sleep(0); // deliver a missing-command spawn error before reporting status
  const deadline = Date.now() + waitMs;
  let state = readJson(file);
  let current = status(state, out);
  while (current.status === "starting" && Date.now() < deadline) {
    await sleep(25);
    state = readJson(file);
    current = status(state, out);
  }
  if (apiKey().key) return connection();
  const text = current.status === "pending" ? `Intent Check: connect your account → ${current.url}\nOpen the link and approve; your task can continue while sign-in finishes.`
    : current.status === "missing" ? SETUP
    : current.status === "starting" ? "Intent Check is starting sign-in through the global CLI. The approval link will appear on your next prompt; your task can continue."
    : current.status === "denied" ? "Intent Check sign-in was denied. Nothing is checked; run intent-check login when you want to reconnect."
    : "Intent Check could not finish sign-in. Run intent-check login to retry; nothing is being checked yet.";
  return { ...current, text, token: `${state?.created_at}:${current.status}` };
}
