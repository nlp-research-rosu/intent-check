import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { proveCommand, assetName } from "../lib/cli.js";
import { sha256 } from "../lib/fsutil.js";
import { tmpdir } from "./helpers/env.js";

const posix = process.platform !== "win32" ? {} : { skip: "the fake CLI is a shell script" };
const V = "9.9.9";

// Serves a tar.gz holding a shell script that answers --version, and counts the requests.
async function fakeRelease({ version = V, badSum = false, content = null, corrupt = false } = {}) {
  const work = tmpdir("intent-cli-");
  const asset = assetName();
  const bin = path.join(work, "intent-check");
  fs.writeFileSync(bin, `#!/bin/sh\necho "intent-check ${version}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(work, "other"), "x");
  execFileSync("tar", ["-czf", path.join(work, asset), "-C", work, content || "intent-check"]);
  const archive = corrupt ? Buffer.from("not an archive") : fs.readFileSync(path.join(work, asset));
  const files = { [`/${asset}`]: archive, [`/${asset}.sha256`]: Buffer.from(`${badSum ? "0".repeat(64) : sha256(archive)}  ${asset}\n`) };
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const f = files[req.url];
    res.writeHead(f ? 200 : 404).end(f);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.INTENT_CLI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.CLAUDE_PLUGIN_DATA = tmpdir("intent-data-");
  return { hits, close: () => server.close() };
}

test("prove: INTENT_CLI_PATH wins and must be an existing absolute path", async () => {
  const f = path.join(tmpdir(), "intent-check");
  fs.writeFileSync(f, "");
  process.env.INTENT_CLI_PATH = f;
  try {
    assert.equal(await proveCommand({ version: V }), f);
    process.env.INTENT_CLI_PATH = "relative/intent-check";
    await assert.rejects(proveCommand({ version: V }), /INTENT_CLI_PATH/);
  } finally {
    delete process.env.INTENT_CLI_PATH;
  }
});

test("prove: downloads, verifies sha256, installs, and skips the download when the version matches", posix, async () => {
  const rel = await fakeRelease();
  try {
    const bin = await proveCommand({ version: V });
    assert.equal(bin, path.join(process.env.CLAUDE_PLUGIN_DATA, "bin", "intent-check"));
    assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /9\.9\.9/);
    assert.equal(fs.readFileSync(`${bin}.version`, "utf8"), V, "the stamp hooks check instead of running the binary");
    assert.equal(rel.hits.length, 2);
    assert.equal(await proveCommand({ version: V }), bin);
    assert.equal(rel.hits.length, 2, "same version: no request");
  } finally {
    rel.close();
  }
});

test("prove: a checksum mismatch installs nothing", posix, async () => {
  const rel = await fakeRelease({ badSum: true });
  try {
    await assert.rejects(proveCommand({ version: V }), /sha256/);
    assert.equal(fs.existsSync(path.join(process.env.CLAUDE_PLUGIN_DATA, "bin", "intent-check")), false);
  } finally {
    rel.close();
  }
});

test("prove: a different installed version is replaced", posix, async () => {
  const rel = await fakeRelease();
  try {
    const bin = path.join(process.env.CLAUDE_PLUGIN_DATA, "bin", "intent-check");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\necho "intent-check 0.0.1"\n', { mode: 0o755 });
    await proveCommand({ version: V });
    assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /9\.9\.9/);
  } finally {
    rel.close();
  }
});

test("prove: asset names and unsupported platforms", async () => {
  assert.equal(assetName("darwin", "arm64"), "intent-check-darwin-arm64.tar.gz");
  assert.equal(assetName("linux", "x64"), "intent-check-linux-x64.tar.gz");
  assert.equal(assetName("win32", "x64"), "intent-check-windows-x64.zip");
  assert.throws(() => assetName("freebsd", "x64"), /no intent-check CLI is published for freebsd\/x64/);
});

test("prove: INTENT_CLI_BASE_URL is only honoured for http://127.0.0.1", async () => {
  process.env.INTENT_CLI_BASE_URL = "https://evil.example/x";
  process.env.CLAUDE_PLUGIN_DATA = tmpdir("intent-data-");
  try {
    await assert.rejects(proveCommand({ version: V }), /INTENT_CLI_BASE_URL/);
  } finally {
    delete process.env.INTENT_CLI_BASE_URL;
  }
});

test("prove: an archive without the binary, or one tar cannot read, installs nothing and says so", posix, async () => {
  for (const [opts, msg] of [[{ content: "other" }, /missing from/], [{ corrupt: true }, /could not unpack/]]) {
    const rel = await fakeRelease(opts);
    try {
      await assert.rejects(proveCommand({ version: V }), msg);
      assert.equal(fs.existsSync(path.join(process.env.CLAUDE_PLUGIN_DATA, "bin", "intent-check")), false);
    } finally {
      rel.close();
    }
  }
});

test("prove: INTENT_CLI_PATH must be a file, not a folder", async () => {
  process.env.INTENT_CLI_PATH = tmpdir();
  try {
    await assert.rejects(proveCommand({ version: V }), /INTENT_CLI_PATH/);
  } finally {
    delete process.env.INTENT_CLI_PATH;
  }
});
