// Minimal JSON-over-HTTP client on node:http/https (global fetch prints an
// ExperimentalWarning on Node 18, which would leak into hook stderr).
import http from "node:http";
import https from "node:https";

// redirect: follow one 3xx to its Location with a bare GET, so the caller's headers (the API key)
// never reach the other host. The result carries `text`, the body as sent.
const MAX_BODY = 8 * 1024 * 1024;

export function requestJson(method, url, { headers = {}, body = null, timeoutMs = 10000, contentType = "application/json", redirect = false } = {}) {
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
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = { accept: "application/json", ...headers };
    if (payload) {
      h["content-type"] = contentType;
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
        if (redirect && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let to;
          try { to = new URL(res.headers.location, u); } catch { return finish({ status: 0, json: null, error: "bad_redirect" }); }
          // https only; plain http only when the API itself is plain http (tests, local runs).
          if (to.protocol !== "https:" && !(to.protocol === "http:" && u.protocol === "http:")) return finish({ status: 0, json: null, error: "bad_redirect" });
          requestJson("GET", to.href, { timeoutMs }).then(finish);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
        });
        res.on("end", () => {
          if (size > MAX_BODY) return finish({ status: 0, json: null, error: "too_large" }); // never hand back a cut-off body
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          finish({ status: res.statusCode || 0, json, text, headers: res.headers });
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

// A binary request body (the gzip'd DeepScan snapshot) with the same timeout and error shape as
// requestJson: { status, json, headers } or { status: 0, error } when nothing came back.
export function requestBinary(method, url, { headers = {}, body, timeoutMs = 60000, contentType = "application/gzip" } = {}) {
  return requestJson(method, url, { headers, body: Buffer.from(body), timeoutMs, contentType });
}
