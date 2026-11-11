#!/usr/bin/env node
// `npm test`: core Scan and upload-safety checks, on any OS and shell (the file list is built here, so
// nothing depends on the shell or Node expanding a glob).
// On Windows the files run one at a time to keep process-start overhead bounded.
// Extra arguments go to `node --test` (for example --test-name-pattern).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join("test", f));
const serial = process.platform === "win32" ? ["--test-concurrency=1"] : [];
const r = spawnSync(process.execPath, ["--test", ...serial, ...process.argv.slice(2), ...files], { cwd: root, stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
