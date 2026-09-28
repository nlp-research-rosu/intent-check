// Hash of every file in contract/ except CONTRACT.sha256 itself.
//   node contract/hash.mjs          -> exit 1 if CONTRACT.sha256 is out of date
//   node contract/hash.mjs --write  -> refresh CONTRACT.sha256
// Zero dependencies so the plugin repo can run it too.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(dir)
  .map((p) => relative(dir, p).split("\\").join("/"))
  .filter((p) => p !== "CONTRACT.sha256")
  .sort();
const h = createHash("sha256");
for (const f of files) {
  h.update(f + "\0");
  h.update(readFileSync(join(dir, f)).toString("utf8").replace(/\r\n/g, "\n"));
  h.update("\0");
}
const digest = h.digest("hex");
const file = join(dir, "CONTRACT.sha256");
if (process.argv.includes("--write")) {
  writeFileSync(file, digest + "\n");
  console.log(digest);
} else {
  const want = readFileSync(file, "utf8").trim();
  if (want !== digest) {
    console.error(`contract hash mismatch: CONTRACT.sha256=${want} actual=${digest}`);
    process.exit(1);
  }
  console.log("contract ok", digest);
}
