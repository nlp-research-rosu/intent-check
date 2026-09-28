// Connect-link onboarding: POST /v1/connect, show the link, and a detached poller that saves
// the API key once the user approves. The pending connect lives in ${CLAUDE_PLUGIN_DATA}/connect.json
// (mode 600: the device code is a secret).
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { dataDir, ensureDataDir, apiKey, saveApiKey, pluginVersion, osName, BIN, C, disabledReason } from "./config.js";
import { readJson, writeJsonAtomic, withLock, isPidAlive, sleep } from "./fsutil.js";
import { startConnect, pollConnect } from "./api.js";
import { log } from "./log.js";

const file = () => path.join(dataDir(), "connect.json");
const lock = () => path.join(dataDir(), "connect.lock");

export function readConnect() {
  const c = readJson(file(), null);
  return c && typeof c === "object" ? c : null;
}

export function updateConnect(fn) {
  ensureDataDir();
  return withLock(lock(), () => {
    const c = readConnect() || {};
    const out = fn(c);
    writeJsonAtomic(file(), c, 0o600);
    return out;
  });
}

function isLive(c, now = Date.now()) {
  return c && c.status === "pending" && typeof c.device_code === "string" && c.expires_at > now + 30000;
}

export function spawnPoller() {
  try {
    const child = spawn(process.execPath, [BIN, "connect-poll"], {
      detached: true, stdio: "ignore", windowsHide: true, env: process.env,
    });
    child.unref();
    return child.pid || null;
  } catch {
    return null;
  }
}

// Returns the verification URL to show, starting a connect request when none is live.
export async function ensureConnectLink(host, hostVersion) {
  let c = readConnect();
  if (!isLive(c)) {
    const r = await startConnect({
      host, host_version: String(hostVersion || "unknown").slice(0, 40), plugin_version: pluginVersion(),
      os: osName(), machine_name: String(os.hostname() || "").slice(0, 80) || null,
    }, 1500);
    if (!r.ok) {
      log("connect.start_failed", { code: r.code });
      return null;
    }
    c = updateConnect((x) => {
      for (const k of Object.keys(x)) delete x[k];
      Object.assign(x, {
        status: "pending",
        device_code: r.device_code,
        user_code: r.user_code,
        verification_url: r.verification_url,
        interval_s: Math.max(1, r.interval),
        expires_at: Date.now() + r.expires_in * 1000,
        created_at: Date.now(),
      });
      return { ...x };
    });
    log("connect.started", {});
  }
  ensurePoller(c);
  return c.verification_url;
}

export function ensurePoller(c = readConnect()) {
  if (!isLive(c) || isPidAlive(c.poller_pid)) return;
  const pid = spawnPoller();
  updateConnect((x) => { x.poller_pid = pid; });
}

// Apply one poll response. Returns "approved" | "pending" | "gone".
function applyPoll(r) {
  if (!r.ok) {
    if (r.status === 404) {
      updateConnect((x) => { x.status = "expired"; delete x.device_code; });
      return "gone";
    }
    return "pending";
  }
  if (r.status === "approved" && r.api_key) {
    saveApiKey(r.api_key);
    updateConnect((x) => { x.status = "approved"; x.announce = true; delete x.device_code; });
    log("connect.approved", {});
    return "approved";
  }
  if (r.status === "pending") return "pending";
  // denied, expired, or consumed (someone else already picked the key up).
  updateConnect((x) => { x.status = r.status; delete x.device_code; });
  return "gone";
}

// One GET, used by the prompt hook as a fallback when the poller died. 1 s budget.
export async function checkConnectOnce(timeoutMs = C.polling.pending_check_timeout_ms) {
  const c = readConnect();
  if (!isLive(c)) return "none";
  return applyPoll(await pollConnect(c.device_code, timeoutMs));
}

// "connected" is announced once, by whichever hook sees it first.
export function takeConnectedAnnouncement() {
  const c = readConnect();
  if (!c || !c.announce) return false;
  return updateConnect((x) => {
    if (!x.announce) return false;
    delete x.announce;
    return true;
  });
}

export async function runPoller() {
  updateConnect((x) => { x.poller_pid = process.pid; });
  const hardStop = Date.now() + C.polling.connect_expires_s * 1000 + 60000;
  let failures = 0;
  while (Date.now() < hardStop && failures < 40) {
    const c = readConnect();
    if (!isLive(c) || c.poller_pid !== process.pid) return;
    if ((apiKey().key && apiKey().source === "config") || disabledReason()) return;
    await sleep(Math.max(1000, (c.interval_s || 3) * 1000));
    const fresh = readConnect();
    if (!isLive(fresh)) return;
    const r = await pollConnect(fresh.device_code, 10000);
    // Service unreachable for a couple of minutes: stop; the next prompt re-checks and restarts us.
    failures = r.ok || r.status ? 0 : failures + 1;
    if (applyPoll(r) !== "pending") return;
  }
}
