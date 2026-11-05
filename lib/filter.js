// Language labels for explicit file reviews and snapshot trim priority.
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

export function extOf(p) {
  const base = p.split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

export function languageOf(p) { return LANGUAGES[extOf(p)] || "text"; }

export function isTestPath(p) {
  const parts = p.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((part) => ["tests", "__tests__", "test", "spec", "__mocks__"].includes(part))) return true;
  return /^test_/.test(base) || /_test\.[^.]+$/.test(base) || /\.(spec|test)\.[^.]+$/.test(base);
}
