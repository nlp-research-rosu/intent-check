// Minimal JSON-over-HTTP client on node:http/https (global fetch prints an
// ExperimentalWarning on Node 18, which would leak into hook stderr).
import http from "node:http";
import https from "node:https";

export function requestJson(method, url, { headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ status: 0, json: null, error: "bad_url" });
      return;
    }
    const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!lib) {
      resolve({ status: 0, json: null, error: "bad_url" });
      return;
    }
    const payload = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = { accept: "application/json", ...headers };
    if (payload) {
      h["content-type"] = "application/json";
      h["content-length"] = String(payload.length);
    }
    let done = false;
    let timer = null;
    let req = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      req = lib.request(u, { method, headers: h }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size <= 8 * 1024 * 1024) chunks.push(c);
        });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
          finish({ status: res.statusCode || 0, json, headers: res.headers });
        });
        res.on("error", () => finish({ status: 0, json: null, error: "network" }));
      });
      req.on("error", () => finish({ status: 0, json: null, error: "network" }));
      if (payload) req.write(payload);
      req.end();
    } catch {
      finish({ status: 0, json: null, error: "network" });
      return;
    }
    timer = setTimeout(() => {
      req.destroy();
      finish({ status: 0, json: null, error: "timeout" });
    }, timeoutMs);
  });
}
