// Explicit Scan submission and collection against the existing controlled service.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { tmpdir, makeRepo, baseEnv, saveKey, BIN, symlink, SKIP_FILE_SYMLINKS } from "./helpers/env.js";
import { validateScan } from "./helpers/schema.js";
import { buildSnapshot } from "../lib/snapshot.js";
import { renderScan } from "../lib/scan.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => { fp.state.scan = {}; fp.state.scans = new Map(); fp.state.requests.length = 0; fp.state.corruptArtifact = false; });

function setup({ key = true } = {}) {
  const data = tmpdir("intent-data-");
  if (key) saveKey(data, TEST_KEY, fp.url);
  const { dir: repo } = makeRepo();
  return { data, repo, env: baseEnv(data, fp.url) };
}
const write = (repo, rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const idOf = (text) => /\/tasks\/([0-9a-f-]{36})/.exec(text)[1];
function cli(args, ctx, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "scan", ...args], { cwd: ctx.cwd || ctx.repo, env: { ...ctx.env, ...extraEnv } });
    let out = "";
    let err = "";
    child.stdout.on("data", (bytes) => { out += bytes; });
    child.stderr.on("data", (bytes) => { err += bytes; });
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

test("snapshot filters/redacts tracked and non-ignored untracked files, preserving the contract", async () => {
  const ctx = setup();
  write(ctx.repo, "src/app.py", "def f():\n    return 1\n");
  write(ctx.repo, "src/secret.py", 'TOKEN = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"\nX = 1\n');
  write(ctx.repo, ".env", "KEY=private\n");
  write(ctx.repo, "node_modules/a.js", "vendored\n");
  write(ctx.repo, "package-lock.json", "{}\n");
  write(ctx.repo, "binary.dat", Buffer.from([0, 1, 2]));
  write(ctx.repo, ".intent/NOTES.md", "- Intended behaviour.\n");
  write(ctx.repo, ".intent/prove/old/PROOF.md", "private evidence\n");
  const snapshot = await buildSnapshot({ cwd: ctx.repo, depth: "fast" });
  assert.equal(snapshot.ok, true);
  const upload = JSON.parse(zlib.gunzipSync(snapshot.gz));
  assert.deepEqual(validateScan(upload, "ScanUpload"), []);
  assert.deepEqual(upload.files.map((file) => file.path), [".intent/NOTES.md", "README.md", "src/app.py", "src/secret.py"]);
  assert.ok(!JSON.stringify(upload.files).includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(upload.depth, "fast");
});

test("snapshot scope is literal, rejects outside paths and does not follow symlinks", { skip: SKIP_FILE_SYMLINKS }, async () => {
  const ctx = setup();
  write(ctx.repo, "src/app.py", "x = 1\n");
  const outside = tmpdir();
  write(outside, "private.py", "private = 1\n");
  symlink(outside, path.join(ctx.repo, "link"));
  assert.equal((await buildSnapshot({ cwd: ctx.repo, scope: "link" })).ok, false);
  const snapshot = await buildSnapshot({ cwd: ctx.repo, scope: "src" });
  assert.deepEqual(JSON.parse(zlib.gunzipSync(snapshot.gz)).files.map((file) => file.path), ["src/app.py"]);
});

test("Scan from a subdirectory submits once and saves the report at the repository root", async () => {
  const ctx = setup();
  write(ctx.repo, "src/app.py", "x = 1\n");
  ctx.cwd = path.join(ctx.repo, "src");
  fp.state.scan.statuses = ["done"];
  const result = await cli([], ctx);
  assert.equal(result.code, 0, result.err);
  const id = idOf(result.out);
  const record = path.join(ctx.data, "scans", `${id}.json`);
  assert.equal(read(record).status, "done");
  assert.match(result.err, /If interrupted, resume with scan collect/);
  assert.match(result.out, /Scan finished/);
  assert.equal(read(record).report_status, "saved");
  assert.match(result.out, /Local HTML report:.*intent-prover view --output <new-file.html>/);
  assert.ok(result.out.includes(`#view=scans&scan=${encodeURIComponent(`scan/${id}/meta.json`)}`));
  const collected = await cli(["collect", id], ctx);
  assert.equal(collected.code, 0, collected.err);
  assert.match(collected.out, /Scan finished/);
  assert.match(collected.out, /Local HTML report:/);
  assert.equal(read(record).report_status, "saved");
  const reportDir = path.join(ctx.repo, ".intent", "scan", id);
  assert.ok(read(path.join(reportDir, "report.json")).coverage);
  assert.equal(read(path.join(reportDir, "meta.json")).report.status, "saved");
  assert.equal(fs.existsSync(path.join(ctx.cwd, ".intent")), false);
  assert.equal(fp.scanUploads().length, 1);
  assert.match((await cli(["collect"], ctx)).out, /No uncollected scans/);
});

test("corrupt reports are rejected without replacing a saved report", async () => {
  const ctx = setup();
  fp.state.corruptArtifact = true;
  const result = await cli([], ctx);
  const id = idOf(result.out);
  const reportDir = path.join(ctx.repo, ".intent", "scan", id);
  const reportFile = path.join(reportDir, "report.json");
  assert.equal(read(path.join(reportDir, "meta.json")).report.status, "pending");
  assert.equal(read(path.join(reportDir, "meta.json")).report.reason, "REPORT_HASH_MISMATCH");
  assert.equal(fs.existsSync(reportFile), false);

  fp.state.corruptArtifact = false;
  const recovered = await cli(["collect", id], ctx);
  assert.equal(recovered.code, 0, recovered.err);
  assert.equal(read(path.join(reportDir, "meta.json")).report.status, "saved");
  const saved = fs.readFileSync(reportFile);

  // A changed artifact reference forces a download instead of reusing the saved copy.
  fp.state.scan.summary = {
    counts: {}, cards: [], oneLiners: [],
    report: { ...read(path.join(reportDir, "meta.json")).task.report, sha256: "0".repeat(64) },
  };
  fp.state.corruptArtifact = true;
  await cli(["collect", id], ctx);
  assert.equal(read(path.join(reportDir, "meta.json")).report.status, "pending");
  assert.equal(read(path.join(reportDir, "meta.json")).report.reason, "REPORT_HASH_MISMATCH");
  assert.deepEqual(fs.readFileSync(reportFile), saved);
  assert.equal(fp.scanUploads().length, 1);
});

test("an interrupted Scan keeps its task record and collect resumes without another upload", async () => {
  const ctx = setup();
  fp.state.scan.statuses = ["running"];
  const child = spawn(process.execPath, [BIN, "scan"], { cwd: ctx.repo, env: ctx.env });
  let err = "";
  let id;
  child.stderr.on("data", (bytes) => {
    err += bytes;
    if (!id && /\/tasks\/[0-9a-f-]{36}/.test(err)) {
      id = idOf(err);
      child.kill("SIGINT");
    }
  });
  await new Promise((resolve) => child.on("close", resolve));
  assert.ok(id, err);
  assert.ok(fs.existsSync(path.join(ctx.data, "scans", `${id}.json`)));
  fp.state.scan.statuses = ["done"];
  const recovered = await cli(["collect", id], ctx);
  assert.equal(recovered.code, 0, recovered.err);
  assert.match(recovered.out, /Saved report/);
  assert.equal(fp.scanUploads().length, 1);
});

test("missing auth, environment opt-outs and invalid targets never submit", async () => {
  const ctx = setup({ key: false });
  assert.equal((await cli([], ctx)).code, 1);
  assert.match((await cli([], ctx)).err, /intent-prover login/);
  const connected = setup();
  assert.equal((await cli([], connected, { INTENT_DISABLED: "1" })).code, 1);
  assert.match((await cli(["missing.py"], connected)).out, /not found/);
  assert.deepEqual(fp.scanUploads(), []);
  assert.equal(fp.state.requests.filter((request) => request.method === "POST").length, 0);
});

test("busy uploads retry once with the same idempotency key", async () => {
  const ctx = setup();
  fp.state.scan.submit = [{ status: 429, code: "RATE_LIMITED", reason: "scan_ingest_busy", retryAfter: 1 }];
  assert.equal((await cli([], ctx)).code, 0);
  const uploads = fp.state.requests.filter((request) => request.method === "POST" && request.path === "/scan");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].headers["idempotency-key"], uploads[1].headers["idempotency-key"]);
});

test("failed scans and malformed summaries do not claim clean results", async () => {
  const ctx = setup();
  fp.state.scan.statuses = ["failed"];
  const result = await cli([], ctx);
  assert.equal(result.code, 1);
  assert.match(result.err, /could not finish/);
  const id = idOf(result.err);
  const collected = await cli(["collect", id], ctx);
  assert.equal(collected.code, 1);
  assert.match(collected.err, /could not finish/);
  assert.doesNotMatch(collected.out + collected.err, /no findings/);
  const rendered = renderScan({ status: "done", url: "https://example.test/report", summary: {} });
  assert.doesNotMatch(rendered.context, /no findings/);
  assert.match(rendered.context, /open the report/);
});
