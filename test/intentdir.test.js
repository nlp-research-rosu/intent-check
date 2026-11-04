import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir, baseEnv, BIN } from "./helpers/env.js";

// Exercise scaffolding through an offline native review request, not a deleted JS helper.
function ensureScaffold(root) {
  const data = tmpdir("intent-scaffold-data-");
  fs.writeFileSync(path.join(root, "a.py"), "X = 1\n");
  execFileSync(BIN, ["review", "a.py"], { cwd: root, env: baseEnv(data, "http://127.0.0.1:9", { INTENT_API_KEY: "fixture-key" }), stdio: "pipe" });
}

// Existing README contents remain untouched; scaffolding performs no migration.
const PAST_README_WITH_NOTES = `# .intent

This folder is written by Intent Check (the \`intent\` plugin for Claude Code and Codex).
Each source file that was checked has a folder here, named by its path from the repo root:

- \`INTENT.md\`: the intent of the code, with its assumptions made explicit
- \`SPEC.k\`: K claims about the code
- \`SEMANTICS.k\`: the code's behaviour as K rewrite rules
- \`VERDICT.md\`: the verdict and any concerns
- \`meta.json\`: the file hash that was checked, when, and the report link

Do not edit these files by hand; the next check of a file updates its folder.

\`NOTES.md\` is yours: one bullet per behaviour you have confirmed is intended. It is sent with every check and those behaviours are not raised again. Everything else here is written by Intent Check.

\`.sent.log\` lists every upload from this repo (paths, sizes, time, where to). It never holds file contents and is not committed.

## Not committing this folder

The folder is meant to be committed. To keep it out of git, add this line to your repo's \`.gitignore\`:

    .intent/

To stop checks altogether, run \`/intent:off\` (or set \`INTENT_DISABLED=1\` or \`DO_NOT_TRACK=1\`).
`;

test("scaffolding does not migrate an existing NOTES.md-era README", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const f = path.join(root, ".intent", "README.md");
  fs.writeFileSync(f, PAST_README_WITH_NOTES);
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), PAST_README_WITH_NOTES);
});

test("scaffold never creates NOTES.md", () => {
  const root = tmpdir();
  ensureScaffold(root);
  assert.equal(fs.existsSync(path.join(root, ".intent", "NOTES.md")), false);
});

// The exact README text this file shipped before the NOTES.md exception was added (see git
// history: lib/intentdir.js as of commit a3c1404). Refresh only recognises byte-exact matches.
const PAST_README = `# .intent

This folder is written by Intent Check (the \`intent\` plugin for Claude Code and Codex).
Each source file that was checked has a folder here, named by its path from the repo root:

- \`INTENT.md\`: the intent of the code, with its assumptions made explicit
- \`SPEC.k\`: K claims about the code
- \`SEMANTICS.k\`: the code's behaviour as K rewrite rules
- \`VERDICT.md\`: the verdict and any concerns
- \`meta.json\`: the file hash that was checked, when, and the report link

Do not edit these files by hand; the next check of a file updates its folder.

\`.sent.log\` lists every upload from this repo (paths, sizes, time, where to). It never holds file contents and is not committed.

## Not committing this folder

The folder is meant to be committed. To keep it out of git, add this line to your repo's \`.gitignore\`:

    .intent/

To stop checks altogether, run \`/intent:off\` (or set \`INTENT_DISABLED=1\` or \`DO_NOT_TRACK=1\`).
`;

test("README is written when missing and never overwrites existing content", () => {
  const root = tmpdir();
  ensureScaffold(root);
  const f = path.join(root, ".intent", "README.md");
  assert.ok(fs.readFileSync(f, "utf8").startsWith("# .intent"));

  // Already current: re-scaffolding does not rewrite it (mtime untouched).
  const before = fs.statSync(f).mtimeMs;
  ensureScaffold(root);
  assert.equal(fs.statSync(f).mtimeMs, before);

  // Even a byte-exact past version is not migrated.
  fs.writeFileSync(f, PAST_README);
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), PAST_README);

  // Our header, but with user text appended below it (not a byte-exact past version): never
  // overwritten, even though it "starts with" our header.
  const headerPlusUserText = "# .intent\n\nAn older version of this file.\n\n## Our team's rule\n\nAlways re-run the checks locally first.\n";
  fs.writeFileSync(f, headerPlusUserText);
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), headerPlusUserText);

  // User-modified, no relation to our header: never overwritten.
  fs.writeFileSync(f, "# My notes about .intent\n\nDo not touch this.\n");
  ensureScaffold(root);
  assert.equal(fs.readFileSync(f, "utf8"), "# My notes about .intent\n\nDo not touch this.\n");
});
