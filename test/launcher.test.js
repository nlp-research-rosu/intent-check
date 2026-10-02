// bin/intent (issue #22): the POSIX sh launcher every hook and command runs, so a machine
// without a usable Node still gets a message instead of every hook failing silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "bin", "intent");

const NO_NODE_MSG = "Intent Check needs Node.js 18 or newer to run. Install it from nodejs.org, then run /reload-plugins.";
const NO_NODE_MSG_CODEX = "Intent Check needs Node.js 18 or newer to run. Install it from nodejs.org, then restart Codex.";

// A PATH with real coreutils (dirname, sed, grep, head, cat, sh itself) but no `node`, so the
// launcher's own `command -v node` lookup genuinely finds nothing. Resolved through a bare `sh -c`
// so an interactive shell's aliases (e.g. `grep` -> `grep --color=auto`) can't leak in as
// `command -v grep` returning a non-path string.
function fakeBinDir({ nodeStub } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-launcher-bin-"));
  for (const c of ["dirname", "sed", "grep", "head", "cat", "sh", "dash", "printf", "mktemp"]) {
    const resolved = spawnSync("/bin/sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).stdout.trim();
    if (resolved) fs.symlinkSync(resolved, path.join(dir, c));
  }
  if (nodeStub) {
    fs.writeFileSync(path.join(dir, "node"), nodeStub, { mode: 0o755 });
  }
  return dir;
}

function run(args, { env, input = "" } = {}) {
  const r = spawnSync("/bin/sh", [LAUNCHER, ...args], { env, input, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function isolatedEnv(fakeBin, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intent-launcher-tmp-"));
  return { env: { PATH: fakeBin, TMPDIR: tmp, HOME: tmp, ...extra }, tmp };
}

test("bin/intent is executable", () => {
  const mode = fs.statSync(LAUNCHER).mode;
  assert.ok(mode & 0o111, "bin/intent must have the executable bit set");
});

test("no Node on PATH: session-start prints exactly one JSON line with the systemMessage", () => {
  const fakeBin = fakeBinDir();
  const { env } = isolatedEnv(fakeBin);
  const r = run(["session-start"], { env, input: JSON.stringify({ session_id: "s1" }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, JSON.stringify({ systemMessage: NO_NODE_MSG }) + "\n");
  assert.equal(r.stderr, "");
});

test("no Node on PATH: session-start --host codex uses hookSpecificOutput.additionalContext and 'restart Codex'", () => {
  const fakeBin = fakeBinDir();
  const { env } = isolatedEnv(fakeBin);
  const r = run(["session-start", "--host", "codex"], { env, input: JSON.stringify({ session_id: "s1" }) });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, NO_NODE_MSG_CODEX);
});

test("no Node on PATH: prompt shows the message once per session, then stays silent", () => {
  const fakeBin = fakeBinDir();
  const { env } = isolatedEnv(fakeBin);
  const payload = JSON.stringify({ session_id: "same-session" });
  const r1 = run(["prompt"], { env, input: payload });
  assert.equal(r1.code, 0);
  assert.equal(r1.stdout, JSON.stringify({ systemMessage: NO_NODE_MSG }) + "\n");
  const r2 = run(["prompt"], { env, input: payload });
  assert.equal(r2.code, 0);
  assert.equal(r2.stdout, "");
});

test("no Node on PATH: prompt in a different session prints again", () => {
  const fakeBin = fakeBinDir();
  const { env } = isolatedEnv(fakeBin);
  const r1 = run(["prompt"], { env, input: JSON.stringify({ session_id: "sess-a" }) });
  assert.notEqual(r1.stdout, "");
  const r2 = run(["prompt"], { env, input: JSON.stringify({ session_id: "sess-b" }) });
  assert.notEqual(r2.stdout, "");
});

test("no Node on PATH: post-tool and stop exit 0 silently", () => {
  const fakeBin = fakeBinDir();
  const { env } = isolatedEnv(fakeBin);
  for (const sub of ["post-tool", "stop", "some-future-subcommand"]) {
    const r = run([sub], { env, input: "{}" });
    assert.equal(r.code, 0, sub);
    assert.equal(r.stdout, "", sub);
    assert.equal(r.stderr, "", sub);
  }
});

test("no Node on PATH: check prints the plain line to stdout and exits 0", () => {
  const fakeBin = fakeBinDir();
  const { env } = isolatedEnv(fakeBin);
  const r = run(["check", "src/foo.py"], { env, input: "" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, NO_NODE_MSG + "\n");
});

test("Node present but older than 18: treated the same as no Node", () => {
  const fakeBin = fakeBinDir({ nodeStub: "#!/bin/sh\necho 16.20.1\n" });
  const { env } = isolatedEnv(fakeBin);
  const r = run(["session-start"], { env, input: JSON.stringify({ session_id: "old-node" }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, JSON.stringify({ systemMessage: NO_NODE_MSG }) + "\n");
});

test("Node >=18 present: exec passthrough of args, stdin and a non-zero exit code with stderr", () => {
  // Isolated temp dir with its own bin/intent (the real launcher) next to a stub intent.js, so
  // `exec node "$dir/intent.js" "$@"` resolves to a script we control instead of the real app.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-launcher-passthrough-"));
  fs.copyFileSync(LAUNCHER, path.join(dir, "intent"));
  fs.chmodSync(path.join(dir, "intent"), 0o755);
  fs.writeFileSync(
    path.join(dir, "intent.js"),
    [
      "let d = '';",
      "process.stdin.on('data', (c) => (d += c));",
      "process.stdin.on('end', () => {",
      "  process.stderr.write('ARGS:' + JSON.stringify(process.argv.slice(2)) + ' STDIN:' + d);",
      "  process.exit(2);",
      "});",
    ].join("\n"),
  );
  const r = spawnSync("/bin/sh", [path.join(dir, "intent"), "stop", "--flag"], {
    env: process.env,
    input: "hello from stdin",
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'ARGS:["stop","--flag"] STDIN:hello from stdin');
});

test("Node >=18 present: the real bin/intent.js still answers through the launcher", () => {
  // No args: lib/queue.js's checkCommand tells the user what to pass, same whichever entry point.
  const out = execFileSync("/bin/sh", [LAUNCHER, "check"], { encoding: "utf8" });
  assert.match(out, /Intent Check: give the files to review/);
});
