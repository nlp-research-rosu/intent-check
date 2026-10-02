import { test } from "node:test";
import assert from "node:assert/strict";
import { includeFile, classifyPath, languageOf, hasLogic } from "../lib/filter.js";

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
  assert.equal(languageOf("a.html"), "html");
  assert.equal(languageOf("a.vue"), "vue");
  assert.equal(languageOf("a.svelte"), "svelte");
  assert.equal(languageOf("a.unknownext"), "text");
});

// Damian's decision (issue #17): check logic inside UI files, skip pure markup and styling.
// .jsx/.tsx/.vue/.svelte/.html are always "needs-content" now (previously .html/.vue/.svelte
// were "no" outright); .css/.scss/.less stay "no".
test("UI files are needs-content, judged on logic inside them", () => {
  assert.equal(classifyPath("index.html"), "needs-content");
  assert.equal(classifyPath("src/App.vue"), "needs-content");
  assert.equal(classifyPath("src/Card.svelte"), "needs-content");
  assert.equal(classifyPath("src/Button.tsx"), "needs-content");
  assert.equal(classifyPath("components/cart.js"), "needs-content");
  assert.equal(classifyPath("styles.css"), "no");
  assert.equal(classifyPath("styles/site.scss"), "no");
  assert.equal(classifyPath("pages/api/x.ts"), "yes");
});

const BUTTON_TSX = `
import React from "react";

export function Button({ label, onClick, variant }) {
  return (
    <button className={variant === "primary" ? "btn btn-primary" : "btn"} onClick={onClick}>
      {label}
    </button>
  );
}
`;

const PENDULUM_TSX = `
import { useState, useEffect } from "react";

function derivative(state, g, L) {
  const { theta, omega } = state;
  const alpha = -(g / L) * Math.sin(theta);
  return { theta: omega, omega: alpha };
}

// RK4 integration of the pendulum ODE.
function rk4Step(state, dt, g, L) {
  const k1 = derivative(state, g, L);
  const k2 = derivative({ theta: state.theta + (dt / 2) * k1.theta, omega: state.omega + (dt / 2) * k1.omega }, g, L);
  const k3 = derivative({ theta: state.theta + (dt / 2) * k2.theta, omega: state.omega + (dt / 2) * k2.omega }, g, L);
  const k4 = derivative({ theta: state.theta + dt * k3.theta, omega: state.omega + dt * k3.omega }, g, L);
  return {
    theta: state.theta + (dt / 6) * (k1.theta + 2 * k2.theta + 2 * k3.theta + k4.theta),
    omega: state.omega + (dt / 6) * (k1.omega + 2 * k2.omega + 2 * k3.omega + k4.omega),
  };
}

export function Pendulum() {
  const [state, setState] = useState({ theta: Math.PI / 4, omega: 0 });
  useEffect(() => {
    const id = setInterval(() => setState((s) => rk4Step(s, 0.016, 9.81, 1)), 16);
    return () => clearInterval(id);
  }, []);
  return <div>{state.theta.toFixed(2)}</div>;
}
`;

const HTML_WITH_INLINE_SCRIPT = `<!doctype html>
<html><body>
<script>
  let angle = Math.PI / 4;
  let velocity = 0;
  function step(dt) {
    const g = 9.81;
    const accel = -g * Math.sin(angle);
    velocity += accel * dt;
    angle += velocity * dt;
    if (angle > Math.PI) {
      angle -= 2 * Math.PI;
    } else if (angle < -Math.PI) {
      angle += 2 * Math.PI;
    }
    return angle;
  }
</script>
</body></html>`;

const HTML_MARKUP_ONLY = `<!doctype html>
<html><body>
<h1>Double pendulum</h1>
<p>Open the console to watch it swing.</p>
<script src="app.js"></script>
</body></html>`;

const CART_JS = `
export function computeTotal(items, coupon) {
  let total = 0;
  for (const item of items) {
    if (item.qty > 0) {
      total += item.price * item.qty;
    }
  }
  if (coupon && coupon.percent) {
    total -= total * (coupon.percent / 100);
  }
  return total;
}
`;

test("presentational components/Button.tsx is skipped (no control flow, no long function)", () => {
  assert.equal(hasLogic(BUTTON_TSX, ".tsx"), false);
  assert.equal(includeFile("components/Button.tsx", BUTTON_TSX), false);
});

test("components/Pendulum.tsx with RK4 physics is checked", () => {
  assert.equal(hasLogic(PENDULUM_TSX, ".tsx"), true);
  assert.equal(includeFile("components/Pendulum.tsx", PENDULUM_TSX), true);
});

test("index.html with an inline <script> simulation is checked", () => {
  assert.equal(hasLogic(HTML_WITH_INLINE_SCRIPT, ".html"), true);
  assert.equal(includeFile("index.html", HTML_WITH_INLINE_SCRIPT), true);
});

test("index.html with markup and a <script src=\"app.js\"> only is skipped", () => {
  assert.equal(hasLogic(HTML_MARKUP_ONLY, ".html"), false);
  assert.equal(includeFile("index.html", HTML_MARKUP_ONLY), false);
});

test("components/cart.js with logic is checked", () => {
  assert.equal(hasLogic(CART_JS, ".js"), true);
  assert.equal(includeFile("components/cart.js", CART_JS), true);
});

test("styles.css is skipped outright, never content-judged", () => {
  assert.equal(includeFile("styles.css", "body { color: red; } /* if (x) { for (;;) {} } */"), false);
});

test("pages/api/x.ts is always yes, even presentational-looking content", () => {
  assert.equal(includeFile("pages/api/x.ts", "export default function handler(req, res) { res.end(); }"), true);
});

test("a \"use server\" UI file is checked even with no other logic", () => {
  const content = '"use server";\n\nexport function Button() {\n  return null;\n}\n';
  assert.equal(hasLogic(content, ".tsx"), true);
  assert.equal(includeFile("components/Button.tsx", content), true);
});

test("hasLogic ignores keywords inside strings and comments", () => {
  const noisy = `
    // if (x) { for (;;) {} } while (true) { switch (x) { case 1: try {} } }
    const msg = "if for while switch case try ? : ? : ? :";
    export function Label({ text }) {
      return <span>{text}</span>;
    }
  `;
  assert.equal(hasLogic(noisy, ".tsx"), false);
});
