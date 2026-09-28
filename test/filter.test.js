import { test } from "node:test";
import assert from "node:assert/strict";
import { includeFile, classifyPath, languageOf } from "../lib/filter.js";

test("includes source files in the language allowlist", () => {
  for (const p of ["pricing.py", "src/auth/login.py", "server/index.ts", "lib/util.mjs", "cmd/main.go", "src/lib.rs",
    "App.java", "Main.kt", "a.c", "a.cpp", "a.cs", "a.swift", "a.rb", "a.php", "Token.sol", "a.scala", "scripts/deploy.sh"]) {
    assert.equal(includeFile(p, ""), true, p);
  }
});

test("excludes UI, tests, vendored, generated, config, docs and lockfiles", () => {
  for (const p of [
    "styles/site.css", "index.html", "src/App.tsx", "src/Button.jsx", "src/App.vue", "src/Card.svelte",
    "src/components/price.ts", "ui/format.js", "views/home.py", "layouts/base.ts", "pages/about.ts",
    "test_pricing.py", "pricing_test.go", "price.spec.ts", "price.test.js", "tests/helpers.py", "src/__tests__/a.js",
    "node_modules/x/index.js", "vendor/lib.go", "dist/app.js", "build/out.js", "third_party/a.c", "app.min.js",
    "package-lock.json", "yarn.lock", "Cargo.lock", "vite.config.ts", "next.config.js", ".eslintrc.js", "README.md", "docs/guide.md",
    ".env", "server.pem", ".intent/pricing.py/SPEC.k", "../outside.py",
  ]) {
    assert.equal(includeFile(p, ""), false, p);
  }
});

test("API routes and server actions trigger even where UI code does not", () => {
  assert.equal(includeFile("pages/api/charge.ts", ""), true);
  assert.equal(includeFile("src/pages/api/users/[id].js", ""), true);
  assert.equal(includeFile("app/api/checkout/route.ts", ""), true);
  assert.equal(includeFile("src/app/(shop)/cart/route.js", ""), true);
  assert.equal(classifyPath("src/components/actions.tsx"), "needs-content");
  assert.equal(includeFile("src/components/actions.tsx", '"use server";\nexport async function pay() {}'), true);
  assert.equal(includeFile("app/actions.tsx", "export async function pay() {\n  'use server'\n}"), true);
  assert.equal(includeFile("src/components/Button.tsx", "export function Button() {}"), false);
  // Carve-outs never override vendored or test exclusions.
  assert.equal(includeFile("node_modules/next/pages/api/x.js", ""), false);
  assert.equal(includeFile("app/api/route.test.ts", ""), false);
});

test("language names", () => {
  assert.equal(languageOf("a.py"), "python");
  assert.equal(languageOf("a.tsx"), "typescript");
  assert.equal(languageOf("a.unknownext"), "text");
});
