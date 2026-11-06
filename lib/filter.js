// File classification for DeepScan snapshot trim priority.

export function extOf(p) {
  const base = p.split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

export function isTestPath(p) {
  const parts = p.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((part) => ["tests", "__tests__", "test", "spec", "__mocks__"].includes(part))) return true;
  return /^test_/.test(base) || /_test\.[^.]+$/.test(base) || /\.(spec|test)\.[^.]+$/.test(base);
}
