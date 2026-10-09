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
// external file (src=) and ones commented out in <!-- --> (no code actually runs there).
function inlineScripts(html) {
  if (typeof html !== "string") return "";
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(live))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out.join("\n");
}

// Extensions whose code text is only their <script> content (see codeTextFor).
const SCRIPT_ONLY_EXT = new Set([".html", ".vue", ".svelte"]);
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

// A "/" opens a regex literal (not division) only when the previous significant character is
// one of these, or we're at the start of a line -- the same cheap heuristic real tokenizers
// use to resolve the division/regex ambiguity.
const REGEX_CONTEXT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", ""]);

// The characters scanCode ever needs to stop and look at; everything else is a run of plain
// code it can skip over in one native regex search instead of a per-character JS loop (the
// difference between ~1ms and ~300ms on a 1 MB file -- see the performance test).
const SPECIAL = /[/"'`{}]/g;

// The last non-whitespace character before `pos`, or "" at the start of a line/file. Only
// walks back through the (short) run of whitespace immediately before `pos`, so it stays cheap.
function lastSignificant(src, pos) {
  for (let k = pos - 1; k >= 0; k--) {
    const ch = src[k];
    if (ch === "\n") return "";
    if (ch !== " " && ch !== "\t" && ch !== "\r") return ch;
  }
  return "";
}

// A cache of all-space strings, grown as needed, so masking a range never builds its
// replacement one character at a time (a single 1 MB string or comment would otherwise cost
// hundreds of milliseconds on its own).
let SPACES = "                                                                ";
function spaces(len) {
  while (SPACES.length < len) SPACES += SPACES;
  return SPACES.slice(0, len);
}

// Same-length replacement for src[from..to): spaces, except newlines (kept so line-based
// counting downstream, hasLongFunction, still lines up with the original source).
function maskRange(src, from, to) {
  const text = src.slice(from, to);
  if (!text.includes("\n")) return spaces(text.length);
  return text.split("\n").map((line) => spaces(line.length)).join("\n");
}

// Scans a template literal starting at the backtick `src[start]`; pushes its (masked, except
// for ${...} expressions) text onto `parts`. ${...} is scanned as real code via scanCode, so a
// ternary or regex inside one is still seen; a nested template works too (scanCode calls back
// into this for any backtick it finds). Returns the index right after the closing backtick (or
// the end of `src` if unterminated).
const TEMPLATE_SPECIAL = /[`\\]|\$\{/g;
function scanTemplate(src, start, parts) {
  const n = src.length;
  let i = start + 1;
  parts.push(" ");
  while (i < n) {
    TEMPLATE_SPECIAL.lastIndex = i;
    const m = TEMPLATE_SPECIAL.exec(src);
    if (!m) { parts.push(maskRange(src, i, n)); return n; }
    if (m.index > i) parts.push(maskRange(src, i, m.index));
    i = m.index;
    if (src[i] === "`") { parts.push(" "); return i + 1; }
    if (src[i] === "\\") { parts.push(maskRange(src, i, i + 2)); i += 2; continue; }
    parts.push("  "); // "${"
    i = scanCode(src, i + 2, parts, true);
  }
  return n;
}

// Scans ordinary code starting at `i`, pushing (masked where appropriate) text onto `parts`.
// When `untilBrace` is set, stops right after the "}" that closes the depth-1 brace opened by
// the "${" that called in here, and returns that index; otherwise scans to the end of `src` and
// returns its length. Comments, strings, regex literals and nested templates are all handled
// the same way regardless of nesting, so this stays a single effectively-linear pass: each
// character is looked at by exactly one active frame (scanCode call or scanTemplate call).
function scanCode(src, i, parts, untilBrace) {
  const n = src.length;
  let depth = untilBrace ? 1 : 0;
  while (i < n) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(src);
    const next = m ? m.index : n;
    if (next > i) parts.push(src.slice(i, next));
    i = next;
    if (i >= n) break;
    const c = src[i];
    if (c === "{") {
      parts.push("{");
      i++;
      if (untilBrace) depth++;
      continue;
    }
    if (c === "}") {
      parts.push("}");
      i++;
      if (untilBrace && --depth === 0) return i;
      continue;
    }
    if (c === "/") {
      if (src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        i = end === -1 ? n : end;
        continue;
      }
      if (src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        parts.push(maskRange(src, i, stop));
        i = stop;
        continue;
      }
      if (REGEX_CONTEXT.has(lastSignificant(src, i))) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") { inClass = true; j++; continue; }
          if (src[j] === "]") { inClass = false; j++; continue; }
          if (src[j] === "/" && !inClass) { j++; closed = true; break; }
          j++;
        }
        if (closed) while (j < n && /[a-zA-Z]/.test(src[j])) j++;
        parts.push(maskRange(src, i, j));
        i = j;
        continue;
      }
      parts.push("/"); // division
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { j += src[j] === "\\" ? 2 : 1; }
      j = Math.min(j + 1, n);
      parts.push(maskRange(src, i, j));
      i = j;
      continue;
    }
    i = scanTemplate(src, i, parts); // c === "`"
  }
  return i;
}

// Strip strings, template literals, regex literals and comments so keywords inside them never
// get counted as logic -- while still treating a template literal's ${...} interpolations as
// real code (so a ternary inside one is seen) and never letting an escaped "/" inside a regex
// (e.g. /^https?:\/\//) get mistaken for the start of a "//" comment.
function stripStringsAndComments(src) {
  const parts = [];
  scanCode(src, 0, parts, false);
  return parts.join("");
}

// ≥3 statements among if/else if/for/while/switch/case/try/ternary ?:, each only counted in
// statement position so JSX prose ("Try again", "in case") never gets mistaken for code:
// try only as "try {", case only as "case ...:", if/for/while/switch only with a "(" (so
// "else if" is still counted, via the "if ("). The ternary match requires a space before and
// after the "?" so TS optional markers ("x?:") and optional chaining/nullish coalescing
// ("a?.b", "a ?? b") are not miscounted.
function countControlFlow(code) {
  let n = 0;
  n += (code.match(/\bif\s*\(/g) || []).length;
  n += (code.match(/\bfor\s*\(/g) || []).length;
  n += (code.match(/\bwhile\s*\(/g) || []).length;
  n += (code.match(/\bswitch\s*\(/g) || []).length;
  n += (code.match(/\bcase\b[^\n:;{}]*:/g) || []).length;
  n += (code.match(/\btry\s*\{/g) || []).length;
  n += (code.match(/\s\?\s/g) || []).length;
  return n;
}

// Computation signals for small single-file apps, whose key logic is a few lines of arithmetic
// rather than three or more if/for statements: Math.* calls, "*", "/" and "%" operators, and
// comparisons. Only run on code text from .html/.vue/.svelte (inline script, never markup), so
// the "/" of a JSX closing tag can't be mistaken for division. Strings, comments and regex
// literals are already stripped. "+" and "-" are left out on purpose: they are mostly string
// concatenation and hyphens, not computation.
function countComputation(code) {
  let n = 0;
  n += (code.match(/\bMath\.\w+\s*\(/g) || []).length;
  n += (code.match(/[*/%]/g) || []).length;
  n += (code.match(/[=!]==?|<=|>=/g) || []).length;
  return n;
}

// Keywords that can precede "(...) {" without being a method/function definition; a
// shorthand-method match naming one of these is really that control-flow statement.
const NOT_A_METHOD_NAME = new Set(["if", "for", "while", "switch", "catch", "function"]);

// name(args) { ... } at statement/property position: start of line, or preceded by "{", ",",
// ";" or an "async"/"static"/"get"/"set" modifier -- covers class methods and object-literal
// shorthand methods, which have no "function" keyword and no "=>".
const METHOD_SHORTHAND = /(^|[{,;])[ \t]*(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/gm;

// Start indices (the opening "{") of every "function ... (...) {", "=> {" and shorthand-method
// body, deduplicated (a "function foo() {" can match more than one pattern).
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
  re = new RegExp(METHOD_SHORTHAND.source, "gm");
  while ((m = re.exec(code))) {
    if (NOT_A_METHOD_NAME.has(m[2])) continue;
    starts.add(m.index + m[0].length - 1);
  }
  return [...starts];
}

// Matches every "{" in `code` to its "}" in one linear pass with a stack, so hasLongFunction
// never re-scans to the end of the file per candidate (which would be quadratic for a file with
// many functions, some with unmatched braces).
function matchAllBraces(code) {
  const match = new Map();
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}") {
      const open = stack.pop();
      if (open !== undefined) match.set(open, i);
    }
  }
  return match;
}

// A function, arrow-function or method body spanning ≥6 non-blank lines.
function hasLongFunction(code) {
  const starts = functionBraceStarts(code);
  if (!starts.length) return false;
  const braceMatch = matchAllBraces(code);
  for (const start of starts) {
    const end = braceMatch.get(start);
    if (end === undefined) continue;
    const body = code.slice(start + 1, end);
    const nonBlank = body.split("\n").filter((l) => l.trim() !== "").length;
    if (nonBlank >= 6) return true;
  }
  return false;
}

// Deterministic verdict for a "needs-content" file: true when "use server" is present
// (existing carve-out, checked against the whole file) OR its code text has logic --
// control flow (≥3 statements), a long function (≥6 non-blank body lines), or, for .html/.vue/
// .svelte script text, control flow plus computation signals totalling ≥3. A presentational
// component (props in, JSX markup out, maybe one ternary) returns false.
export function hasLogic(content, ext) {
  if (hasUseServer(content)) return true;
  const code = stripStringsAndComments(codeTextFor(content, ext));
  if (!code.trim()) return false;
  const flow = countControlFlow(code);
  if (flow >= 3 || hasLongFunction(code)) return true;
  // A tiny HTML/Vue/Svelte app can hold real logic (a clamp, a rounding rule, a cents split) in
  // under three statements. Control flow and computation signals together need to reach 3.
  return SCRIPT_ONLY_EXT.has(ext) && flow + countComputation(code) >= 3;
}

export function includeFile(relPath, content) {
  const c = classifyPath(relPath);
  if (c === "needs-content") return hasLogic(content, extOf(relPath));
  return c === "yes";
}
