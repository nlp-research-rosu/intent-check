// Explicit Scan submission and collection against the existing controlled service.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { tmpdir, makeRepo, baseEnv, saveKey, BIN, symlink, SKIP_FILE_SYMLINKS } from "./helpers/env.js";
import { validateDeepscan, validateDef } from "./helpers/schema.js";
import { buildSnapshot, normaliseRemote, pathReason, decodeText } from "../lib/snapshot.js";
import { takeDepth, renderScan } from "../lib/deepscan.js";

let fp;
before(async () => { fp = createFakeProver({ pollsBeforeDone: 0 }); await fp.listen(); });
after(() => fp.close());
beforeEach(() => { fp.state.deepscan = {}; fp.state.scans = new Map(); fp.state.requests.length = 0; fp.state.submitStatus = null; });

function setup({ key = true } = {}) {
  const data = tmpdir("intent-data-");
  if (key) saveKey(data, TEST_KEY, fp.url);
  const { dir: repo, git } = makeRepo();
  return { data, repo, git, env: baseEnv(data, fp.url) };
}
const write = (repo, rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const idOf = (text) => /\/tasks\/([0-9a-f-]{36})/.exec(text)[1];
function cli(args, ctx, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "deepscan", ...args], { cwd: ctx.repo, env: { ...ctx.env, ...extraEnv } });
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
  assert.deepEqual(validateDeepscan(upload, "DeepscanUpload"), []);
  assert.deepEqual(upload.files.map((file) => file.path), [".intent/NOTES.md", "README.md", "src/app.py", "src/secret.py"]);
  assert.ok(!JSON.stringify(upload.files).includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(upload.depth, "fast");
  assert.equal(pathReason(".env"), "secret");
  assert.equal(decodeText(Buffer.from([0xff])), null);
  assert.equal(normaliseRemote("git@github.com:org/repo.git"), "https://github.com/org/repo");
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

test("repository Scan submits once and stays queued until explicit collection saves the report", async () => {
  const ctx = setup();
  const result = await cli([], ctx);
  assert.equal(result.code, 0, result.err);
  const id = idOf(result.out);
  const record = path.join(ctx.data, "deepscans", `${id}.json`);
  assert.equal(read(record).status, "queued");
  assert.equal(read(record).waiter, undefined);
  assert.equal(fp.state.requests.filter((request) => request.method === "GET").length, 0);
  assert.match(result.out, /deepscan collect/);
  const collected = await cli(["collect", id], ctx);
  assert.equal(collected.code, 0, collected.err);
  assert.match(collected.out, /DeepScan finished/);
  assert.equal(read(record).report_status, "saved");
  const reportDir = path.join(ctx.repo, ".intent", "deepscan", id);
  assert.ok(read(path.join(reportDir, "report.json")).coverage);
  assert.equal(read(path.join(reportDir, "meta.json")).report.status, "saved");
  assert.equal(fp.deepscanUploads().length, 1);
  assert.match((await cli(["collect"], ctx)).out, /No uncollected scans/);
});

test("explicit file Scan submits immediately without prompts, and collect saves file evidence", async () => {
  const ctx = setup();
  write(ctx.repo, "pricing.py", "def f():\n    return 1\n");
  const result = await cli(["pricing.py"], ctx);
  assert.equal(result.code, 0, result.err);
  const id = idOf(result.out);
  const jobs = fp.jobRequests();
  assert.equal(jobs.length, 1);
  assert.deepEqual(validateDef(jobs[0], "JobRequest"), []);
  assert.equal(jobs[0].mode, "request");
  assert.deepEqual(jobs[0].intent.prompts, []);
  assert.equal(jobs[0].intent.agent_message, null);
  assert.deepEqual(jobs[0].units.map((unit) => unit.path), ["pricing.py"]);
  const collected = await cli(["collect", id], ctx);
  assert.equal(collected.code, 0, collected.err);
  assert.match(collected.out, /File Scan finished/);
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent", "pricing.py", "VERDICT.md")));
  assert.equal(fp.jobRequests().length, 1);
});

test("upgrade retains settings, evidence and old queues without consuming automatic work", async () => {
  const ctx = setup();
  const config = '{"live":true,"disabled":true}\n';
  fs.writeFileSync(path.join(ctx.data, "config.json"), config);
  write(ctx.repo, ".intent/.queue/1-12345678.json", '{"mode":"request","paths":["private.py"]}');
  write(ctx.repo, ".intent/old/VERDICT.md", "retained evidence");
  write(ctx.repo, "pricing.py", "x = 1\n");
  const result = await cli(["pricing.py"], ctx, { INTENT_LIVE: "1" });
  assert.equal(result.code, 0, result.err);
  assert.equal(fs.readFileSync(path.join(ctx.data, "config.json"), "utf8"), config);
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent/.queue/1-12345678.json")));
  assert.equal(fs.readFileSync(path.join(ctx.repo, ".intent/old/VERDICT.md"), "utf8"), "retained evidence");
  assert.deepEqual(fp.jobRequests()[0].units.map((unit) => unit.path), ["pricing.py"]);
  // A pre-update DeepScan record remains usable without its waiter/delivery machinery.
  const deep = await cli([], ctx);
  const id = idOf(deep.out);
  const file = path.join(ctx.data, "deepscans", `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...read(file), waiter: { pid: null, token: "old", at: 0 }, delivered: true }));
  assert.match((await cli(["collect", id], ctx)).out, /Saved report:/);
});

test("collection is project/service scoped and never resubmits code", async () => {
  const ctx = setup();
  const id = idOf((await cli([], ctx)).out);
  const other = { ...ctx, repo: makeRepo().dir };
  const requests = fp.state.requests.length;
  assert.match((await cli(["collect", id], other)).out, /No local Scan record/);
  assert.equal(fp.state.requests.length, requests);
  assert.equal((await cli(["collect", "invalid"], ctx)).code, 1);
  await cli(["collect", id], ctx);
  await cli(["collect", id], ctx);
  assert.equal(fp.deepscanUploads().length, 1);
});

test("missing auth, environment opt-outs and invalid targets never submit", async () => {
  const ctx = setup({ key: false });
  assert.equal((await cli([], ctx)).code, 1);
  assert.match((await cli([], ctx)).err, /intent-check login/);
  const connected = setup();
  assert.equal((await cli([], connected, { INTENT_DISABLED: "1" })).code, 1);
  assert.match((await cli(["missing.py"], connected)).out, /not found/);
  assert.match((await cli(["--scope"], connected)).out, /not a DeepScan option/);
  assert.deepEqual(fp.deepscanUploads(), []);
  assert.deepEqual(fp.jobRequests(), []);
});

test("busy uploads retry once with the same idempotency key", async () => {
  const ctx = setup();
  fp.state.deepscan.submit = [{ status: 429, code: "RATE_LIMITED", reason: "deepscan_ingest_busy", retryAfter: 1 }];
  assert.equal((await cli([], ctx)).code, 0);
  const uploads = fp.state.requests.filter((request) => request.method === "POST" && request.path === "/deepscans");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].headers["idempotency-key"], uploads[1].headers["idempotency-key"]);
});

test("failed scans and malformed summaries do not claim clean results", async () => {
  const ctx = setup();
  fp.state.deepscan.statuses = ["failed"];
  const id = idOf((await cli([], ctx)).out);
  assert.match((await cli(["collect", id], ctx)).out, /could not finish/);
  const rendered = renderScan({ status: "done", url: "https://example.test/report", summary: {} });
  assert.doesNotMatch(rendered.context, /no findings/);
  assert.match(rendered.context, /open the report/);
});

test("depth is one bare word and defaults to fast", () => {
  assert.deepEqual(takeDepth([]), { depth: "fast", given: false });
  const args = ["src", "FULL"];
  assert.deepEqual(takeDepth(args), { depth: "full", given: true });
  assert.deepEqual(args, ["src"]);
  assert.match(takeDepth(["fast", "full"]).error, /one depth/);
});
