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
  for (const c of ["dirname", "sed", "grep", "head", "cat", "sh", "dash", "printf", "mktemp", "mkdir"]) {
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

test("no Node on PATH: deepscan prints the plain line to stdout and exits 0", () => {
  const fakeBin = fakeBinDir();
  const { env } = isolatedEnv(fakeBin);
  const r = run(["deepscan", "src/foo.py"], { env, input: "" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, NO_NODE_MSG + "\n");
});

test("marker safety: a session id with path separators or .. collapses to the shared safe key", () => {
  const fakeBin = fakeBinDir();
  const { env, tmp } = isolatedEnv(fakeBin);
  const evil = "../../../../tmp/evil-escape";
  const r = run(["prompt"], { env, input: JSON.stringify({ session_id: evil }) });
  assert.equal(r.code, 0);
  assert.notEqual(r.stdout, ""); // first time for the sanitized "nosession" key: still prints
  // Exactly one marker, directly under TMPDIR, named for the safe fallback key: nothing escaped.
  assert.deepEqual(fs.readdirSync(tmp), ["intent-check-nonode-nosession"]);
  assert.equal(fs.existsSync("/tmp/evil-escape"), false);
});

test("marker safety: a pre-existing symlink at the marker path is not followed, and its target is untouched", () => {
  const fakeBin = fakeBinDir();
  const { env, tmp } = isolatedEnv(fakeBin);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "intent-launcher-evil-target-"));
  fs.writeFileSync(path.join(target, "sentinel"), "untouched");
  const markerPath = path.join(tmp, "intent-check-nonode-sess1");
  fs.symlinkSync(target, markerPath);
  const r = run(["prompt"], { env, input: JSON.stringify({ session_id: "sess1" }) });
  assert.equal(r.code, 0);
  // mkdir on an existing path (even a symlink) fails with EEXIST instead of following it, so this
  // behaves like "already shown this session" rather than writing inside the symlink's target.
  assert.equal(r.stdout, "");
  assert.deepEqual(fs.readdirSync(target), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(target, "sentinel"), "utf8"), "untouched");
  assert.ok(fs.lstatSync(markerPath).isSymbolicLink(), "the marker symlink itself must be left alone");
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
  // A flag is refused before anything is read or sent, same whichever entry point.
  const out = execFileSync("/bin/sh", [LAUNCHER, "deepscan", "--nope"], { encoding: "utf8" });
  assert.match(out, /--nope is not a DeepScan option/);
});

test("exec-form hooks from hooks.json spawn node directly and exit 0", () => {
  const h = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  let n = 0;
  for (const ev of Object.keys(h)) {
    for (const entry of h[ev]) {
      for (const hook of entry.hooks) {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), "intent-launcher-data-"));
        try {
          const r = spawnSync(hook.command, hook.args.map((a) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT)), { env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: data, INTENT_DISABLED: "1" }, input: "{}", encoding: "utf8" });
          assert.equal(r.status, 0, `${ev} ${hook.args.join(" ")}: ${r.stderr}`);
          n++;
        } finally {
          fs.rmSync(data, { recursive: true, force: true });
        }
      }
    }
  }
  assert.ok(n >= 5, `expected every hook entry to run, ran ${n}`);
});
