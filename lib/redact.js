// Client-side secret redaction, applied to everything before it leaves the machine:
// file content, diffs, prompts, plan, todos and the agent message. Secrets are replaced
// within the line (never deleting lines) so file:line references stay correct.
// Rule set: research/05 §4.3, adapted from gitleaks' default config (MIT).
import { C } from "./config.js";

const KEYWORDS = "secret|passw(?:or)?d|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth";
const KEYWORD_RE = new RegExp(KEYWORDS, "i");

const mark = (rule) => `‹redacted:${rule}›`;

function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// A value that is just a name (an identifier, a function call, an env lookup) is not a secret.
function looksLikeSecretValue(v) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !/\d/.test(v)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v) || /[()]/.test(v)) return false;
  if (/^(?:process\.env|os\.environ|getenv|ENV\[|\$\{|\$[A-Z_]|<|\(|\[|self\.|this\.)/.test(v)) return false;
  if (/^(?:true|false|null|none|undefined|changeme|password|secret|example)$/i.test(v)) return false;
  return entropy(v) >= 3.5;
}

// Each rule: [name, regex, replacer?]. Order matters: specific formats before generic ones.
const RULES = [
  ["private-key", /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g,
    // Keep the line count, and a leading diff marker on each line, so diffs stay well-formed.
    (m) => m.split("\n").map((l, i) => (i === 0 ? mark("private-key") : "+- ".includes(l[0] || "x") ? l[0] : "")).join("\n")],
  ["intent-key", new RegExp(C.api_key.redaction_regex, "g")],
  ["aws-key", /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{82})\b/g],
  ["anthropic-key", /\bsk-ant-[a-z]{3,6}\d{2}-[A-Za-z0-9_-]{80,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,99}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["slack-webhook", /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g],
  ["google-key", /\bAIza[\w-]{35}\b/g],
  ["jwt", /\bey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_.-]{66}\b/g],
  ["twilio-key", /\bSK[0-9a-fA-F]{32}\b/g],
  ["bearer-token", /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g,
    (m, pre, tok) => (tok.includes("‹redacted") ? m : `${pre}${mark("bearer-token")}`)],
  // Base64 key material on a line of its own (a PEM body whose BEGIN/END lines are elsewhere).
  ["key-body", /^([+\- ]?)(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{60,}={0,2}$/gm,
    (m, pre) => `${pre}${mark("private-key")}`],
  ["url-credentials", /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:)([^\s@/]{3,128})@/gi,
    (m, pre, pass) => (pass.startsWith("‹redacted") ? m : `${pre}${mark("url-credentials")}@`)],
  ["keyword-assignment",
    new RegExp(`([\\w.-]*(?:${KEYWORDS})[\\w.-]*)(["'\`]?\\]?\\s*(?::=|=>|=|:)\\s*["'\`]?)([^\\s"'\`;,]{8,})`, "gi"),
    (m, name, op, value) => (!value.includes("‹redacted") && looksLikeSecretValue(value) ? `${name}${op}${mark("keyword-assignment")}` : m)],
  ["env-line", /^([+\- ]?\s*(?:export\s+)?)([A-Z][A-Z0-9_]{2,})(\s*=\s*)(\S{8,})$/gm,
    (m, pre, name, eq, value) =>
      !value.includes("‹redacted") && (KEYWORD_RE.test(name) || entropy(value) >= 3.5) && looksLikeSecretValue(value.replace(/^["']|["']$/g, ""))
        ? `${pre}${name}${eq}${mark("env-line")}`
        : m],
];

// Line numbers (1-based) inside PEM private-key blocks of a file's raw content.
export function keyBlockLines(content) {
  const out = new Set();
  if (typeof content !== "string" || !content.includes("PRIVATE KEY")) return out;
  const lines = content.split("\n");
  let inBlock = false;
  lines.forEach((l, i) => {
    if (/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY/.test(l)) inBlock = true;
    if (inBlock) out.add(i + 1);
    if (/-----END[ A-Z0-9_-]{0,100}PRIVATE KEY/.test(l)) inBlock = false;
  });
  return out;
}

// Redact a unified diff, and also mask its context/added lines that fall inside a private-key
// block of the current file, even when the hunk shows neither the BEGIN nor the END line.
export function redactDiff(diff, content) {
  const r = redact(diff);
  const keyLines = keyBlockLines(content);
  if (!keyLines.size) return r;
  let count = r.count;
  let newLine = 0;
  let inHunk = false;
  const out = r.text.split("\n").map((line) => {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { inHunk = true; newLine = Number(h[1]); return line; }
    if (line.startsWith("diff --git ")) { inHunk = false; return line; }
    if (!inHunk || line[0] === "-" || line[0] === "\\") return line;
    const n = newLine++;
    if (keyLines.has(n) && !line.includes("‹redacted")) { count++; return line[0] + mark("private-key"); }
    return line;
  });
  return { text: out.join("\n"), count };
}

// Returns { text, count }.
export function redact(input) {
  if (typeof input !== "string" || !input) return { text: input, count: 0 };
  let text = input;
  let count = 0;
  for (const [name, re, fn] of RULES) {
    re.lastIndex = 0;
    text = text.replace(re, (...args) => {
      const out = fn ? fn(...args) : mark(name);
      if (out !== args[0]) count++;
      return out;
    });
  }
  return { text, count };
}

// Files that are never uploaded, even when their extension is on the allowlist.
const NEVER = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|kdbx|tfstate)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/i,
  /(^|\/)credentials(\.(json|ya?ml|ini|txt))?$/i,
  /(^|\/)\.?aws\/credentials$/i,
];

export function neverUpload(relPath) {
  return NEVER.some((re) => re.test(relPath));
}
