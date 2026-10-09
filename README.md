# intent-check

The `intent` plugin for Claude Code and Codex. It checks code your agent writes against what you asked for, in the background, and reports concerns with a link to a shareable report.

Status: private pre-release, under construction.

## When it checks

Automatically, after each turn that changes code with logic (functions, state, calculations) by at least 3 lines. It skips styling, markup-only files, tests, config and vendored code. To review on demand, ask the agent ("review pricing.py") or run `intent check <files>`.

## What is sent, and what stays local

After a turn that changes source files, the plugin sends to the Intent Check service:

- your last few prompts in the session (and the first one), the approved plan and todo items, and the agent's final message for the turn
- the diff of each changed source file and the file itself (large files: only the changed regions)
- the plugin version, host, OS and permission mode
- `.intent/NOTES.md`, if present

Obvious secrets (private keys, cloud and API tokens, `KEY=value` lines with random-looking values) are masked on your machine before anything is sent. Files such as `.env*`, `*.pem` and `id_rsa*` are never sent. Tests, styling and markup-only files, generated and vendored code, config and docs are not sent either.

Every upload is listed in `.intent/.sent.log` in your repo (paths, sizes, time, URL; never contents). Results are written to `.intent/`, which is meant to be committed; its README explains how to keep it out of git.

Turn it off with `/intent:off` in Claude Code (back on with `/intent:on`), or set `INTENT_DISABLED=1` or `DO_NOT_TRACK=1` on either host. While off, nothing is sent.

## Install (Claude Code)

Install steps for every tool, interface (desktop app, CLI, VS Code) and OS are in [docs/install.json](docs/install.json), which the website's install picker uses. The two sections below are the CLI short form.

Requirements: Node.js 18+ on your `PATH` (get it at nodejs.org). The same goes for Codex.

In a Claude Code session, type:

```
/plugin install intent --marketplace nlp-research-rosu/intent-check
```

It asks you to confirm the source, then installs. Or, in a terminal:

```bash
claude plugin marketplace add nlp-research-rosu/intent-check && claude plugin install intent@intentcomputing
```

Then restart Claude Code or run `/reload-plugins`. Your first prompt shows a link to connect your account; once you approve it, checks start. The saved key lives in Claude Code's plugin data folder, which is removed when you uninstall the plugin.

## Modes

Intent Check has two modes. Set one with `/intent:mode classic` or `/intent:mode per-edit` in Claude Code (`/intent:mode` alone shows the current one, and so does `/intent:status`). The choice is saved in the plugin's `config.json` as `mode`; `INTENT_MODE=classic` or `per-edit` in the environment overrides it. The default is classic.

- **classic:** one review per turn. When your agent finishes a turn that changed code, the changes are sent together and the result arrives as a note.
- **per-edit:** every edit is checked as it happens. Each Edit, Write, MultiEdit or Codex `apply_patch` is sent for review on its own and runs to completion. Files written through shell commands (`Bash`) are found by a background scan of the working tree against the start of the turn and checked the same way. Concerns reach the agent with its next edit or shell command, and anything still running at the end of the turn is picked up there. Shell-written files need a git repository.

On Codex, ask the agent to switch ("turn per-edit mode on", "back to classic mode"); it runs the plugin's `intent.js mode per-edit` (or `classic`), which may need your approval to write outside the sandbox. Hooks run `node` directly (Node.js 18+ on your PATH).

A setting from an earlier per-edit preview (`per_edit` in `config.json`) is read as `mode`: `true` is per-edit, `false` is classic.

## Updating

Claude Code only updates a plugin when its version changes, and it does not auto-update third-party marketplaces unless you turn that on. To turn it on, open `/plugin`, go to Marketplaces, select `intentcomputing` and choose Enable auto-update. With auto-update on, a new version can take up to about 10 minutes to arrive after your first message. To update right now, open `/plugin`, go to Marketplaces, select `intentcomputing` and choose Update marketplace, then go to Installed, select `intent` and choose Update now. In a terminal, run `claude plugin marketplace update intentcomputing` and then `claude plugin update intent@intentcomputing`. A running session keeps the old version until you run `/reload-plugins` or restart Claude Code. `claude plugin list` shows the installed version in its Version column.

Maintainers: in GitHub, open Actions, select release, choose Run workflow, pick the branch and the bump (patch, minor or major). On `main` it bumps the version, commits, tags and publishes a release. On any other branch it does the same as a prerelease (for example `0.1.2-per-edit.1`), committed to that branch, since people who install from a branch get its latest commit. After merging `main` into `per-edit` (or any branch users install from), press Release on that branch before telling users to update. Otherwise the branch head may carry a version string that is already installed, and nobody updates.

## Install (Codex CLI 0.147 or newer)

In a terminal:

```bash
codex plugin marketplace add nlp-research-rosu/intent-check && codex plugin add intent@intentcomputing
```

Then start `codex` and choose "Trust all and continue" when it says the plugin's hooks need review (or trust them in `/hooks`). Your first prompt shows the link to connect your account.

Intent Check 0.2.0 updated its edit hook (it now also runs after `apply_patch` and shell commands in per-edit mode). If Codex lists it as Modified, approve it in `/hooks` (or the app's hook review); the first session after the update says so once.

If you already had the plugin trusted, updating to the `node .../bin/intent.js` hook commands (they used to run through the `sh` launcher `bin/intent`) changes them, so Codex asks you to trust them again once. Codex hooks are plain command strings, so the same `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" ...` line serves every OS;
- Codex cannot wake an idle session, so concerns reach the agent with your next message (or at the end of the same turn, if the check already finished). Clean checks show one short "no concerns" line the next time you prompt.
- Codex does not load plugin slash commands, so there is no `/intent:off`. To turn checks off, set `INTENT_DISABLED=1` when starting Codex, or ask the agent to turn Intent Check off (it runs the plugin's `intent.js off`, which may need your approval to write outside the sandbox).
- To ask for a review, ask the agent to check specific files ("check auth.py with Intent Check"), or for a whole-repo scan, ask for a DeepScan.

## Asking for a review

Ask the agent to check specific files ("check auth.py with Intent Check"); the `intent-check` skill runs `intent check <paths>` for it, and the review runs after the turn. In a project without git, run `intent check` from the project root (the folder the session started in).

## DeepScan (whole repo)

`/intent:deepscan` (Codex: ask the agent for a DeepScan, it runs `intent deepscan`) scans the whole repo for behaviour that breaks what the code is meant to do. It runs on the service, so it does not hold up your session. Pick a depth:

| Depth | Takes | Best for |
|---|---|---|
| `fast` (default) | about 15-20 min | the everyday whole-repo scan |
| `balanced` | about 30-35 min | a deeper pass with both models |
| `full` | about 40-45 min | the deepest pass, before a release or a handover |

    /intent:deepscan [fast|balanced|full] [--scope <folder>]

- What is sent: a snapshot of the files git tracks plus untracked files that are not ignored, as one compressed upload. Left out: files git ignores, binary files, lockfiles, vendored and generated folders (node_modules, vendor, dist, build, ...), files over 512 KB, and anything that looks like a secrets file. Obvious secrets inside the files are masked first. The limits are 3000 files and 15 MB of text; when a repo is larger, the least relevant files are dropped first and the command says so. Use `--scope <folder>` to scan one part of a big repo.
- The upload is listed in `.intent/.sent.log` (paths and sizes, never contents). Intent Check must be on and connected; `INTENT_DISABLED=1` stops DeepScan too.
- The command prints the report link and returns. When the scan finishes, a short summary with the top findings appears at your next message in that repo (also in a new session), once. The link shows the full report and live progress.
- Findings are flagged, not reproduced. Ask the agent to reproduce the ones you care about.
- Whole-repo review used to be `check --repo`; that is replaced by DeepScan.

## Sample reports

Reports from the staging service:

- [orders.ts: pagination](https://web-staging-7e1c.up.railway.app/r/XCIS3Vb88lln4Zj6Fa4pSX)
- [dedupe.go: order of results](https://web-staging-7e1c.up.railway.app/r/R5gTYyfhQRfH6vnJKLKt7j)
- [Proration rounding](https://web-staging-7e1c.up.railway.app/r/wQTp6MDv1EZ3PGelmcK2Kt)

## Development

- Zero runtime dependencies. Plain ESM JavaScript, Node 18 syntax.
- `npm test` (node:test) and `node contract/hash.mjs`. `npm run test:integration` runs the real `claude -p` and `codex exec` against a mock model API and the fake prover (no LLM, no secrets; skips a CLI that is not installed); CI runs it on Linux, macOS and Windows. `test/e2e/claude-e2e.sh` drives a real Claude Code session through tmux; `test/e2e/codex-e2e.sh` runs `codex exec` in an isolated `CODEX_HOME`.
- Contract with the backend: `contract/` (identical copy in `nlp-research-rosu/intent-check-prover`).
- Config: `INTENT_API_URL` overrides the service URL, `INTENT_API_KEY` the saved key.
- `NOTICE` lists the Apache-2.0 code this plugin ports from Anthropic's security-guidance plugin.
