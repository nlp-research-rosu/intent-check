// Which changed files trigger a check (PRD "Triggers and file filter", plus the build-plan
// carve-out: API routes and "use server" files always count even though UI code does not).
//
// Damian's decision (issue #17): check logic *inside* UI files (functions, state,
// calculations), and keep skipping pure markup and styling. A UI file only counts when its
// code text has real logic -- see hasLogic() below -- not merely because it lives in a
// components/pages/views-shaped file.
import { neverUpload } from "./redact.js";

export const LANGUAGES = {
  ".py": "python", ".pyi": "python",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescript",
  ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
  ".cs": "csharp", ".swift": "swift", ".rb": "ruby", ".php": "php", ".sol": "solidity", ".vy": "vyper",
  ".scala": "scala", ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".lua": "lua", ".dart": "dart", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".hs": "haskell", ".ml": "ocaml", ".clj": "clojure", ".jl": "julia", ".zig": "zig",
  ".m": "objective-c", ".mm": "objective-c", ".pl": "perl", ".pm": "perl", ".groovy": "groovy",
  ".fs": "fsharp", ".nim": "nim", ".r": "r", ".move": "move", ".cairo": "cairo",
  ".html": "html", ".vue": "vue", ".svelte": "svelte",
};

// Markup/component extensions: always "needs-content", judged on their code text (see
// codeTextFor). Style extensions: pure presentation, always "no".
const MARKUP_EXT = new Set([".jsx", ".tsx", ".vue", ".svelte", ".html"]);
const STYLE_EXT = new Set([".css", ".scss", ".less"]);
const UI_EXT = new Set([...MARKUP_EXT, ...STYLE_EXT]);
const UI_DIRS = new Set(["components", "ui", "views", "pages", "layouts", "styles"]);
const VENDOR_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", "third_party", ".git", ".intent",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", "__generated__", "bower_components",
]);
const TEST_DIRS = new Set(["tests", "__tests__", "test", "spec", "__mocks__"]);
const CONFIG_BASENAME = /^(?:[\w.-]+\.config\.[cm]?[jt]s|\.[\w-]+rc\.[cm]?js|gulpfile\.[cm]?js|gruntfile\.[cm]?js|setup\.py|conftest\.py|manage\.py)$/i;

export function extOf(p) {
  const base = p.split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

export function languageOf(p) {
  return LANGUAGES[extOf(p)] || "text";
}

export function isTestPath(p) {
  const parts = p.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => TEST_DIRS.has(d))) return true;
  return /^test_/.test(base) || /_test\.[^.]+$/.test(base) || /\.(spec|test)\.[^.]+$/.test(base);
}

// API routes: pages/api/** and app/**/route.{ts,js}.
export function isApiRoute(p) {
  const parts = p.split("/");
  const base = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 2; i++) if (parts[i] === "pages" && parts[i + 1] === "api") return true;
  return /^route\.(?:ts|js)$/.test(base) && parts.slice(0, -1).includes("app");
}

export function hasUseServer(content) {
  return typeof content === "string" && /(^|[\s;{])["']use server["']/.test(content);
}

// Path-only verdict: "yes", "no", or "needs-content" (a UI file judged on whether its code
// text has logic -- see hasLogic).
export function classifyPath(relPath) {
  const p = relPath.replace(/\\/g, "/");
  if (!p || p.startsWith("../") || p.startsWith("/")) return "no";
  if (neverUpload(p)) return "no";
  const parts = p.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => VENDOR_DIRS.has(d))) return "no";
  if (/\.min\.[^.]+$/.test(base)) return "no";
  if (isTestPath(p)) return "no";
  if (CONFIG_BASENAME.test(base)) return "no";
  const ext = extOf(p);
  if (!LANGUAGES[ext] && !UI_EXT.has(ext)) return "no";
  if (isApiRoute(p)) return "yes";
  if (STYLE_EXT.has(ext)) return "no";
  if (MARKUP_EXT.has(ext)) return "needs-content";
  const jsFamily = /^\.(?:[cm]?[jt]sx?)$/.test(ext);
  const inUiDir = parts.slice(0, -1).some((d) => UI_DIRS.has(d));
  if (inUiDir) return jsFamily ? "needs-content" : "no";
  return "yes";
}

// Pull the inline <script> blocks out of an .html document, skipping ones that load an
// external file (src=) since there is no local code text to judge there.
function inlineScripts(html) {
  if (typeof html !== "string") return "";
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out.join("\n");
}

const JS_FAMILY_EXT = /^\.(?:[cm]?[jt]sx?)$/;

// The code text hasLogic() should judge: the whole file for the JS/TS family, only the inline
// <script> text (no src=) for .html, and only the <script> section(s) for .vue/.svelte (a
// src= on those naturally has no inline body to extract either).
function codeTextFor(content, ext) {
  if (typeof content !== "string") return "";
  if (JS_FAMILY_EXT.test(ext)) return content;
  if (ext === ".html" || ext === ".vue" || ext === ".svelte") return inlineScripts(content);
  return content;
}

// Strip string/template literals and comments so keywords inside them never get counted as
// logic. Newlines are preserved (replaced characters become spaces) so line-based counting
// downstream (hasLongFunction) still lines up with the original source.
function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ≥3 statements among if/else if/for/while/switch/case/try/ternary ?:. The ternary match
// requires a space before and after the "?" so TS optional markers ("x?:") and optional
// chaining/nullish coalescing ("a?.b", "a ?? b") are not miscounted.
function countControlFlow(code) {
  let n = 0;
  n += (code.match(/\bif\s*\(/g) || []).length;
  n += (code.match(/\bfor\s*\(/g) || []).length;
  n += (code.match(/\bwhile\s*\(/g) || []).length;
  n += (code.match(/\bswitch\s*\(/g) || []).length;
  n += (code.match(/\bcase\b/g) || []).length;
  n += (code.match(/\btry\b/g) || []).length;
  n += (code.match(/\s\?\s/g) || []).length;
  return n;
}

// Start indices (the opening "{") of every "function ... (...) {" and "=> {" body.
function functionBraceStarts(code) {
  const starts = new Set();
  let re = /\bfunction\b[^(){}]*\(/g;
  let m;
  while ((m = re.exec(code))) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === "{") starts.add(i);
  }
  re = /=>\s*\{/g;
  while ((m = re.exec(code))) starts.add(m.index + m[0].lastIndexOf("{"));
  return [...starts];
}

function matchBrace(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// A function or arrow-function body spanning ≥6 non-blank lines.
function hasLongFunction(code) {
  for (const start of functionBraceStarts(code)) {
    const end = matchBrace(code, start);
    if (end === -1) continue;
    const body = code.slice(start + 1, end);
    const nonBlank = body.split("\n").filter((l) => l.trim() !== "").length;
    if (nonBlank >= 6) return true;
  }
  return false;
}

// Deterministic verdict for a "needs-content" file: true when "use server" is present
// (existing carve-out, checked against the whole file) OR its code text has logic --
// control flow (≥3 statements) or a long function (≥6 non-blank body lines). A presentational
// component (props in, JSX markup out, maybe one ternary) returns false.
export function hasLogic(content, ext) {
  if (hasUseServer(content)) return true;
  const code = stripStringsAndComments(codeTextFor(content, ext));
  if (!code.trim()) return false;
  return countControlFlow(code) >= 3 || hasLongFunction(code);
}

export function includeFile(relPath, content) {
  const c = classifyPath(relPath);
  if (c === "needs-content") return hasLogic(content, extOf(relPath));
  return c === "yes";
}
