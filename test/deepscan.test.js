// Explicit Scan submission and collection against the existing controlled service.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createFakeProver, TEST_KEY } from "./helpers/fake-prover.js";
import { tmpdir, makeRepo, baseEnv, saveKey, BIN, symlink, SKIP_FILE_SYMLINKS } from "./helpers/env.js";
import { validateDeepscan } from "./helpers/schema.js";
import { buildSnapshot, normaliseRemote, pathReason, decodeText } from "../lib/snapshot.js";
import { takeDepth, renderScan, submitFailureLine } from "../lib/deepscan.js";

let fp;
before(async () => { fp = createFakeProver(); await fp.listen(); });
after(() => fp.close());
beforeEach(() => { fp.state.deepscan = {}; fp.state.scans = new Map(); fp.state.requests.length = 0; });

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

test("repository Scan submits once, polls through running and saves the report before returning", async () => {
  const ctx = setup();
  fp.state.deepscan.statuses = ["queued", "running", "done"];
  const result = await cli([], ctx);
  assert.equal(result.code, 0, result.err);
  const id = idOf(result.out);
  const record = path.join(ctx.data, "deepscans", `${id}.json`);
  assert.equal(read(record).status, "done");
  assert.equal(read(record).waiter, undefined);
  assert.equal(fp.state.requests.filter((request) => request.method === "GET" && request.path === `/tasks/${id}`).length, 3);
  assert.match(result.err, /If interrupted, resume with deepscan collect/);
  assert.match(result.out, /DeepScan finished/);
  assert.equal(read(record).report_status, "saved");
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

test("a file-scoped DeepScan uses the snapshot API and saves its report before returning", async () => {
  const ctx = setup();
  write(ctx.repo, "pricing.py", "def f():\n    return 1\n");
  write(ctx.repo, "unrelated.py", "private = 1\n");
  const result = await cli(["pricing.py", "full"], ctx);
  assert.equal(result.code, 0, result.err);
  const id = idOf(result.out);
  const uploads = fp.deepscanUploads();
  assert.equal(uploads.length, 1);
  assert.deepEqual(validateDeepscan(uploads[0], "DeepscanUpload"), []);
  assert.deepEqual(uploads[0].files.map((file) => file.path), ["pricing.py"]);
  assert.equal(uploads[0].meta.scope, "pricing.py");
  assert.equal(uploads[0].depth, "full");
  assert.match(result.out, /DeepScan finished/);
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent", "deepscan", id, "report.json")));
  assert.equal(read(path.join(ctx.data, "deepscans", `${id}.json`)).status, "done");
  assert.equal(fs.existsSync(path.join(ctx.data, "file-scans")), false);
  assert.deepEqual([...new Set(fp.state.requests.filter((request) => request.method === "POST").map((request) => request.path))], ["/deepscans"]);
  const collected = await cli(["collect", id], ctx);
  assert.equal(collected.code, 0, collected.err);
  assert.match(collected.out, /DeepScan finished/);
  assert.equal(fp.deepscanUploads().length, 1);
});

test("Scan leaves unrelated local state and existing evidence untouched", async () => {
  const ctx = setup();
  const config = '{"user_setting":"retained"}\n';
  fs.writeFileSync(path.join(ctx.data, "config.json"), config);
  write(ctx.repo, ".intent/.queue/1-12345678.json", '{"mode":"request","paths":["private.py"]}');
  write(ctx.repo, ".intent/old/VERDICT.md", "retained evidence");
  write(ctx.repo, "pricing.py", "x = 1\n");
  const result = await cli(["pricing.py"], ctx);
  assert.equal(result.code, 0, result.err);
  assert.equal(fs.readFileSync(path.join(ctx.data, "config.json"), "utf8"), config);
  assert.ok(fs.existsSync(path.join(ctx.repo, ".intent/.queue/1-12345678.json")));
  assert.equal(fs.readFileSync(path.join(ctx.repo, ".intent/old/VERDICT.md"), "utf8"), "retained evidence");
  assert.deepEqual(fp.deepscanUploads()[0].files.map((file) => file.path), ["pricing.py"]);
});

test("collection is project/service scoped and never resubmits code", async () => {
  const ctx = setup();
  const id = idOf((await cli([], ctx)).out);
  const other = { ...ctx, repo: makeRepo().dir };
  const requests = fp.state.requests.length;
  assert.match((await cli(["collect", id], other)).out, /No local DeepScan record/);
  assert.equal(fp.state.requests.length, requests);
  assert.equal((await cli(["collect", "invalid"], ctx)).code, 1);
  await cli(["collect", id], ctx);
  await cli(["collect", id], ctx);
  assert.equal(fp.deepscanUploads().length, 1);
});

test("an interrupted Scan keeps its task record and collect resumes without another upload", async () => {
  const ctx = setup();
  fp.state.deepscan.statuses = ["running"];
  const child = spawn(process.execPath, [BIN, "deepscan"], { cwd: ctx.repo, env: ctx.env });
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
  assert.ok(fs.existsSync(path.join(ctx.data, "deepscans", `${id}.json`)));
  fp.state.deepscan.statuses = ["done"];
  const recovered = await cli(["collect", id], ctx);
  assert.equal(recovered.code, 0, recovered.err);
  assert.match(recovered.out, /Saved report/);
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
  assert.match((await cli(["a.py", "b.py"], connected)).out, /one file or folder/);
  assert.deepEqual(fp.deepscanUploads(), []);
  assert.equal(fp.state.requests.filter((request) => request.method === "POST").length, 0);
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
  const result = await cli([], ctx);
  assert.equal(result.code, 1);
  assert.match(result.err, /could not finish/);
  const id = idOf(result.err);
  const collected = await cli(["collect", id], ctx);
  assert.equal(collected.code, 1);
  assert.match(collected.err, /could not finish: DeepScan did not produce a usable report\. Try again, or scan one smaller folder\./);
  const rendered = renderScan({ status: "done", url: "https://example.test/report", summary: {} });
  assert.doesNotMatch(rendered.context, /no findings/);
  assert.match(rendered.context, /open the report/);
});

test("a failed scan adds the next step its code calls for", () => {
  const failed = (code) => renderScan({ status: "failed", url: "u", error: { code, message: "Fixed text." } }).context;
  assert.equal(failed("SERVICE_UNAVAILABLE"), "DeepScan could not finish: Fixed text. Try again later. · u");
  assert.equal(failed("INVALID_INPUT"), "DeepScan could not finish: Fixed text. Scan again; if it repeats, scan one smaller folder. · u");
  assert.equal(failed("SPEND_CAP"), "DeepScan could not finish: Fixed text. · u");
  assert.equal(failed("SOMETHING_NEW"), "DeepScan could not finish: Fixed text. · u");
});

test("an account waiting for approval is sent to apply", () => {
  const line = submitFailureLine({ status: 403, code: "ACCESS_NOT_APPROVED" });
  assert.match(line, /not approved for Prover yet\. Apply at https?:\/\/\S+\/apply/);
});

test("depth is one bare word and defaults to fast", () => {
  assert.deepEqual(takeDepth([]), { depth: "fast", given: false });
  const args = ["src", "FULL"];
  assert.deepEqual(takeDepth(args), { depth: "full", given: true });
  assert.deepEqual(args, ["src"]);
  assert.match(takeDepth(["fast", "full"]).error, /one depth/);
});
