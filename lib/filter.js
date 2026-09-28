// Which changed files trigger a check (PRD "Triggers and file filter", plus the build-plan
// carve-out: API routes and "use server" files always count even though UI code does not).
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
};

const UI_EXT = new Set([".jsx", ".tsx", ".vue", ".svelte", ".css", ".scss", ".less", ".html"]);
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

// Path-only verdict: "yes", "no", or "needs-content" (a UI file that may be a server action).
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
  const jsFamily = /^\.(?:[cm]?[jt]sx?)$/.test(ext);
  const inUiDir = parts.slice(0, -1).some((d) => UI_DIRS.has(d));
  if (UI_EXT.has(ext) || inUiDir) return jsFamily ? "needs-content" : "no";
  return "yes";
}

export function includeFile(relPath, content) {
  const c = classifyPath(relPath);
  if (c === "needs-content") return hasUseServer(content);
  return c === "yes";
}
