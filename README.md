# intent-check

The `intent` plugin for Claude Code and Codex. It checks code your agent writes against what you asked for, in the background, and reports concerns with a link to a shareable report.

Status: private pre-release, under construction.

## When it checks

Automatically, after each turn that changes code with logic (functions, state, calculations) by at least 3 lines. It skips styling, markup-only files, tests, config and vendored code. To review on demand, ask the agent ("review pricing.py") or run `/intent:deepscan <files>`.

## What is sent, and what stays local

After a turn that changes source files, the plugin sends to the Intent Check service:

- your last few prompts in the session (and the first one), the approved plan and todo items, and the agent's final message for the turn
- the diff of each changed source file and the file itself (large files: only the changed regions)
- the plugin version, host, OS and permission mode
- `.intent/NOTES.md`, if present

Obvious secrets (private keys, cloud and API tokens, `KEY=value` lines with random-looking values) are masked on your machine before anything is sent. Files such as `.env*`, `*.pem` and `id_rsa*` are never sent. Tests, styling and markup-only files, generated and vendored code, config and docs are not sent either.

Every upload is listed in `.intent/.sent.log` in your repo (paths, sizes, time, URL; never contents). Results are written to `.intent/`, which is meant to be committed; its README explains how to keep it out of git.

Turn it off with `/intent:off` in Claude Code (back on with `/intent:on` or `/intent:live`), or set `INTENT_DISABLED=1` or `DO_NOT_TRACK=1` on either host. While off, nothing is sent.

## Install (Claude Code)

Detailed steps for each tool, interface (desktop app, CLI, VS Code) and OS are in [docs/install.json](docs/install.json). The two sections below are the CLI short form.

Requirements: Node.js 18+ on your `PATH` (get it at nodejs.org). The same goes for Codex.

In a Claude Code session, type:

```
/plugin install intent --marketplace nlp-research-rosu/intent-check
```

It asks you to confirm the source, then installs. Or, in a terminal:

```bash
claude plugin install intent --marketplace nlp-research-rosu/intent-check
```

This needs Claude Code 2.1.292 or newer. On an older version, run `claude plugin marketplace add nlp-research-rosu/intent-check` and then `claude plugin install intent@intentcomputing`.

Then restart Claude Code or run `/reload-plugins`. Your first prompt shows a link to connect your account; once you approve it, checks start. If anything looks wrong later, run `/intent:doctor`. The saved key lives in Claude Code's plugin data folder, which is removed when you uninstall the plugin.

## Commands

| Command | What it does |
|---|---|
| `/intent:on` | Turns Intent Check on. Your changes are checked at the end of each turn. |
| `/intent:live` | Turns Intent Check on in live mode: every edit is also checked as it happens. |
| `/intent:off` | Nothing is sent until `/intent:on` or `/intent:live`. |
| `/intent:deepscan [files or a folder] [fast\|balanced\|full]` | A review on demand: the whole repo, one folder, or specific files. See [DeepScan](#deepscan). |
| `/intent:doctor` | Shows the plugin's state and repairs what it can. See below. |

**On and live.** While Intent Check is on, each turn that changed code is reviewed when it ends, and the result arrives as a note. Live mode adds a review of every edit as it happens: each Edit, Write, MultiEdit or Codex `apply_patch` is sent on its own and runs to completion, and files written through shell commands (`Bash`) are found by a background scan of the working tree against the start of the turn. Concerns reach the agent with its next edit or shell command, and anything still running at the end of the turn is picked up there. A file that a live check already covered is not sent again at the end of the turn. Shell-written files need a git repository. `/intent:on` goes back to end-of-turn reviews only.

The choice is saved in the plugin's `config.json` as `live`. `INTENT_LIVE=1` or `0` in the environment overrides it, which is useful where the plugin's data folder is not writable. A setting from an earlier version (`mode: "per-edit"` or `per_edit: true`) is read as live.

**Doctor.** `/intent:doctor` prints the version, the service, the account, whether checks are on, the last check and the last error, and then repairs what it can:

- Not connected: it shows a fresh link to connect your account.
- The service no longer accepts the saved key: it forgets the key and shows a fresh link.
- An update: on Claude Code it runs `claude plugin marketplace update` and `claude plugin update` for you, and tells you to run `/reload-plugins` when a new version was installed. Where the `claude` command is not available (the desktop app, for example) it says how to update by hand.
- Anything only you can fix (checks turned off, an environment variable, no network) is listed as a "To do" line.

To revoke a machine's key, use your account page on the service; uninstalling the plugin removes the saved key from the machine.

On Codex, ask the agent ("turn live mode on", "run the Intent Check doctor"); it runs the plugin's `intent.js live`, `on`, `off` or `doctor`, which may need your approval to write outside the sandbox. Hooks run `node` directly (Node.js 18+ on your PATH).

## Updating

Claude Code only updates a plugin when its version changes, and it does not auto-update third-party marketplaces unless you turn that on. To turn it on, open `/plugin`, go to Marketplaces, select `intentcomputing` and choose Enable auto-update. With auto-update on, a new version can take up to about 10 minutes to arrive after your first message. To update right now, open `/plugin`, go to Marketplaces, select `intentcomputing` and choose Update marketplace, then go to Installed, select `intent` and choose Update now. In a terminal, run `claude plugin marketplace update intentcomputing` and then `claude plugin update intent@intentcomputing`. A running session keeps the old version until you run `/reload-plugins` or restart Claude Code. `claude plugin list` shows the installed version in its Version column.

Maintainers: in GitHub, open Actions, select release, choose Run workflow, pick the branch and the bump (patch, minor or major). On `main` it bumps the version, commits, tags and publishes a release. On any other branch it does the same as a prerelease (for example `0.1.2-per-edit.1`), committed to that branch, since people who install from a branch get its latest commit. After merging `main` into `per-edit` (or any branch users install from), press Release on that branch before telling users to update. Otherwise the branch head may carry a version string that is already installed, and nobody updates.

## Install (Codex CLI 0.147 or newer)

In a terminal:

```bash
codex plugin marketplace add nlp-research-rosu/intent-check
codex plugin add intent@intentcomputing
```

The Codex IDE extension (VS Code) and the Codex desktop app load the same plugins. Run these commands in a terminal, then restart the extension or app.

Then start `codex` and choose "Trust all and continue" when it says the plugin's hooks need review (or trust them in `/hooks`). Your first prompt shows the link to connect your account.

Intent Check 0.2.0 updated its edit hook (it now also runs after `apply_patch` and shell commands in live mode). If Codex lists it as Modified, approve it in `/hooks` (or the app's hook review); the first session after the update says so once.

If you already had the plugin trusted, updating to the `node .../bin/intent.js` hook commands (they used to run through the `sh` launcher `bin/intent`) changes them, so Codex asks you to trust them again once. Codex hooks are plain command strings, so the same `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" ...` line serves every OS;
- Codex cannot wake an idle session, so concerns reach the agent with your next message (or at the end of the same turn, if the check already finished). Clean checks show one short "no concerns" line the next time you prompt.
- Codex does not load plugin slash commands. Ask the agent instead ("turn Intent Check off", "turn live mode on", "run the Intent Check doctor"); it runs the plugin's `intent.js off`, `live` or `doctor`, which may need your approval to write outside the sandbox. `INTENT_DISABLED=1` when starting Codex also turns checks off.
- To ask for a review, ask the agent to check specific files ("check auth.py with Intent Check"), or for a whole-repo scan, ask for a DeepScan.
- The doctor does not update the plugin on Codex; update it from Codex's plugin list.

## DeepScan

`/intent:deepscan` is the one command for a review on demand (Codex: ask the agent, it runs `intent deepscan`). What it does depends on what you name:

    /intent:deepscan [files or a folder] [fast|balanced|full]

- **Files** (at most 10): the fast review. The request is queued, runs when the turn ends and takes a few minutes; the result arrives as a note. You can also just ask the agent ("check auth.py with Intent Check"). In a project without git, run it from the project root (the folder the session started in).
- **Nothing, or one folder**: a scan of the whole repo, or of that part of it, for behaviour that breaks what the code is meant to do. It runs on the service, so it does not hold up your session. Pick a depth:

| Depth | Takes | Best for |
|---|---|---|
| `fast` (default) | about 15-20 min | the everyday whole-repo scan |
| `balanced` | about 30-35 min | a deeper pass: both models hunt every property |
| `full` | about 40-45 min | the deepest pass, before a release or a handover |

For a whole-repo or folder scan:

- What is sent: a snapshot of the files git tracks plus untracked files that are not ignored, as one compressed upload. Left out: files git ignores, binary files, lockfiles, vendored and generated folders (node_modules, vendor, dist, build, ...), files over 512 KB, and anything that looks like a secrets file. Obvious secrets inside the files are masked first. The limits are 3000 files and 15 MB of text; when a repo is larger, the least relevant files are dropped first and the command says so. Name a folder to scan one part of a big repo.
- DeepScan reads your code, not Intent Check's own `.intent/` results (except `.intent/NOTES.md`).
- The upload is listed in `.intent/.sent.log` (paths and sizes, never contents). Intent Check must be on and connected; `INTENT_DISABLED=1` stops DeepScan too.
- The command prints the report link and returns. When the scan finishes, a short summary with the top findings appears at your next message in that repo (also in a new session), once. The link shows the full report and live progress.
- Findings are flagged, not reproduced. Ask the agent to reproduce the ones you care about.

Earlier versions had a separate `check` command for files, and `--depth` and `--scope` flags; both are now plain arguments of `deepscan`.

## Sample reports

Reports from https://check.intentcomputing.org:

- [orders.ts: pagination](https://check.intentcomputing.org/r/Ri36hNtU302qOdWTVLCukw)
- [dedupe.go: order of results](https://check.intentcomputing.org/r/rgAroTW9Bvv1333vlPRUwm)
- [Proration rounding](https://check.intentcomputing.org/r/r1XfQRd9dhvI0LlcdttHHN)

## Development

- Zero runtime dependencies. Plain ESM JavaScript, Node 18 syntax.
- `npm test` (node:test) and `node contract/hash.mjs`. `npm run test:integration` runs the real `claude -p` and `codex exec` against a mock model API and the fake prover (no LLM, no secrets; skips a CLI that is not installed); CI runs it on Linux, macOS and Windows. `test/e2e/claude-e2e.sh` drives a real Claude Code session through tmux; `test/e2e/codex-e2e.sh` runs `codex exec` in an isolated `CODEX_HOME`.
- Contract with the backend: `contract/` (identical copy in `nlp-research-rosu/intent-check-prover`).
- Config: `INTENT_API_URL` overrides the service URL, `INTENT_API_KEY` the saved key. `INTENT_DEBUG=1` adds one line per hook call to `intent.log` in the plugin data folder. Test-only: `INTENT_PIPELINE=llm|canned` (honoured only where the server allows overrides), `INTENT_DEEPSCAN_POLL_MS` and `INTENT_DEEPSCAN_BUSY_MS` (waits in tests).
- `NOTICE` lists the Apache-2.0 code this plugin ports from Anthropic's security-guidance plugin.
