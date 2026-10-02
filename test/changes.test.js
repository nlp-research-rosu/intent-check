// collectChanges-level coverage for the UI-logic filter (issue #17): a new index.html with an
// inline <script> simulation becomes a reviewable unit, while markup-only HTML does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo } from "./helpers/env.js";
import { collectChanges } from "../lib/changes.js";

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
<script src="app.js"></script>
</body></html>`;

test("collectChanges: a new index.html with an inline script becomes a unit", async () => {
  const { dir } = makeRepo({ git: true });
  const abs = path.join(dir, "index.html");
  fs.writeFileSync(abs, HTML_WITH_INLINE_SCRIPT);
  const { root, git, files } = await collectChanges({ baseline: null, touched: [abs] }, dir);
  assert.equal(git, true);
  assert.equal(root, dir);
  assert.equal(files.length, 1);
  assert.equal(files[0].rel, "index.html");
  assert.match(files[0].diff, /^--- \/dev\/null\n\+\+\+ b\/index\.html/);
});

test("collectChanges: a new index.html with markup only produces no unit", async () => {
  const { dir } = makeRepo({ git: true });
  const abs = path.join(dir, "index.html");
  fs.writeFileSync(abs, HTML_MARKUP_ONLY);
  const { files } = await collectChanges({ baseline: null, touched: [abs] }, dir);
  assert.equal(files.length, 0);
});
