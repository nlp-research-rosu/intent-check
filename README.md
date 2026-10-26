# intent-check

The `intent` plugin for Claude Code and Codex. It checks code your agent writes against what you asked for, in the background, and reports concerns with a link to the result in the Intent Check console. It has four modes:

- **check**: reviews each turn that changed code, when the turn ends (`/intent:on`).
- **live**: also reviews every edit as it happens (`/intent:live`).
- **deepscan**: a review on demand of files, a folder or the whole repo (`/intent:deepscan`).
- **prove**: formal proofs with K, for properties a review cannot settle (`/intent:prove`).

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

Every upload is listed in `.intent/.sent.log` in your repo (paths, sizes, time, URL; never contents). Everything the plugin writes in your repo goes under `.intent/`, which is meant to be committed; its README explains how to keep it out of git.

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

Then restart Claude Code or run `/reload-plugins`. If the global CLI is installed, hooks show a browser sign-in link automatically. Otherwise ask the agent to follow `onboarding` to install it. Approve the link to enable checks; your task can continue while sign-in is pending. If anything looks wrong later, run `/intent:doctor`. See [Signing in](#signing-in).

## Commands

| Command | What it does |
|---|---|
| `/intent:on` | Turns Intent Check on. Your changes are checked at the end of each turn. |
| `/intent:live` | Turns Intent Check on in live mode: every edit is also checked as it happens. |
| `/intent:off` | Nothing is sent until `/intent:on` or `/intent:live`. |
| `/intent:deepscan [files or a folder] [fast\|balanced\|full]` | A review on demand: the whole repo, one folder, or specific files. See [DeepScan](#deepscan). |
| `/intent:prove [what to prove]` | Formal proof with K. See [Prove](#prove). |
| `/intent:doctor` | Shows the plugin's state and repairs what it can. See below. |

**On and live.** While Intent Check is on, each turn that changed code is reviewed when it ends, and the result arrives as a note. Live mode adds a review of every edit as it happens: each Edit, Write, MultiEdit or Codex `apply_patch` is sent on its own and runs to completion, and files written through shell commands (`Bash`) are found by a background scan of the working tree against the start of the turn. Concerns reach the agent with its next edit or shell command, and anything still running at the end of the turn is picked up there. A file that a live check already covered is not sent again at the end of the turn. Shell-written files need a git repository. `/intent:on` goes back to end-of-turn reviews only.

The choice is saved in the plugin's `config.json` as `live`. `INTENT_LIVE=1` or `0` in the environment overrides it, which is useful where the plugin's data folder is not writable.

**Doctor.** `/intent:doctor` prints the version, the service, the account, whether checks are on, the last check and the last error, and then repairs what it can:

- Not signed in: it points to onboarding and `intent-check login`.
- The service no longer accepts the saved key: it forgets the key and asks you to run `intent-check login` again.
- A newer release: the first line names it ("v0.2.3 (v0.2.4 available)"). It reads the release tags of the marketplace the plugin was installed from, so it also works where the plugin cannot update itself.
- An update: on Claude Code it runs `claude plugin marketplace update` and `claude plugin update` for you, and tells you to run `/reload-plugins` when a new version was installed. Where the `claude` command is not available (the desktop app, for example) it says how to update by hand.
- Anything only you can fix (checks turned off, an environment variable, no network) is listed as a "To do" line.

To revoke a machine's key, use the Intent Check console. Uninstalling the plugin does not remove the saved key, because the `intent-check` command shares it; delete `credentials.json` (see below) to sign out.

On Codex, ask the agent ("turn live mode on", "run the Intent Check doctor"); it runs the plugin's `hooks.js live`, `on`, `off` or `doctor`, which may need your approval to write outside the sandbox. Hooks run `node` directly (Node.js 18+ on your PATH).

## Signing in

Use `onboarding` to install the global `intent-check` CLI. Without a key, hooks run `intent-check login` in the background and show its browser approval link, without blocking your task. Concurrent sessions share that login; a later prompt confirms approval once. If the CLI is missing, hooks point to onboarding and never install a private copy. You can also run `intent-check login` yourself: keep it running until it reports `connected`. The CLI saves the key in `~/.config/intent-check/credentials.json` (`$XDG_CONFIG_HOME/intent-check/` when set, `%APPDATA%\intent-check\` on Windows). Keys are stored per API origin. The plugin and command share that file, so you sign in once for both.

In the cloud and in CI, where nobody can open a link, set `INTENT_API_KEY` to a key from the Intent Check console. It takes precedence over the saved key, for the plugin and the command.

The plugin and CLI share endpoint settings in `~/.config/intent-check/config.toml` (the same XDG/Windows directory as credentials). Set `server_url` for the API and `portal_url` for the console. `INTENT_API_URL` and `INTENT_CONSOLE_URL` override them; blank variables count as unset. The plugin reads TOML through the global `intent-check config` command. Plugin preferences such as `disabled` and `live` remain host-local in `config.json`; endpoints do not.

## Prove

`/intent:prove [what to prove]` proves a program correct with K: partial correctness (if it terminates and the precondition holds, the postcondition holds). The agent follows the proof skills (`using-prove` and the skills it points to), calling the global `intent-check` CLI directly. If setup is missing, it uses `onboarding`. On Codex, ask the agent to prove something.

Proof files go under `.intent/prove/<target>/`, one folder per program or function (spec, scope, `PROOF.md`, scripts). Commit them. The CLI's session state is in `.intent/prove/sessions/`; do not commit that folder. All `.intent/` paths are relative to the automatically detected repository root, even when commands run from a subdirectory. Outside a repository, the CLI uses the project directory. Results are shown in the Intent Check console.

## The `intent-check` command

Install the global CLI once for both skills and terminal use. The plugin package contains skills and JavaScript review hooks, not a native executable or private binary cache. Each release has the Rust binary for macOS, Linux and Windows (x64 and arm64), with checksums, and an installer:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/nlp-research-rosu/intent-check/releases/latest/download/install-intent-check.sh | sh
```

On Windows, download `install-intent-check.ps1` from the same release and run it in PowerShell. Then run `intent-check login`, `intent-check health` and `intent-check semantics`.

## Environment variables

| Variable | Effect |
|---|---|
| `INTENT_API_URL` | The Intent Check service API the plugin and the CLI talk to (default `https://prover.intentcomputing.org`). |
| `INTENT_CONSOLE_URL` | The Intent Check console that sign-in and result links open in, for the plugin and the CLI. |
| `INTENT_API_KEY` | The API key, instead of the saved one, for the plugin and the CLI. For cloud sessions and CI. |
| `INTENT_DISABLED=1` | Turns the plugin off; nothing is sent. |
| `DO_NOT_TRACK=1` | The same. |
| `INTENT_LIVE=1` or `0` | Sets live mode, overriding the saved choice. |

## Updating

To see which version you have, run `/intent:doctor`: its first line shows the installed version, and a newer release when there is one. `/plugin` (Installed) and `claude plugin list` show it too. What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

Claude Code only updates a plugin when its version changes, and it does not auto-update third-party marketplaces unless you turn that on. To turn it on, open `/plugin`, go to Marketplaces, select `intentcomputing` and choose Enable auto-update. With auto-update on, a new version can take up to about 10 minutes to arrive after your first message. To update right now, open `/plugin`, go to Marketplaces, select `intentcomputing` and choose Update marketplace, then go to Installed, select `intent` and choose Update now. In a terminal, run `claude plugin marketplace update intentcomputing` and then `claude plugin update intent@intentcomputing`. A running session keeps the old version until you run `/reload-plugins` or restart Claude Code. `claude plugin list` shows the installed version in its Version column.

Maintainers: in GitHub, open Actions, select release, choose Run workflow, pick the branch and the bump (patch, minor or major; pick minor when a command or option was removed or renamed). On `main` it prepares a version-bump commit, turns the Unreleased section of `CHANGELOG.md` into that version's section, builds all CLI targets, tags and publishes a release with that section as its notes, then advances the branch to the prepared commit. The matching CLI assets are therefore available before plugin installations see the new version; a failed build leaves the branch untouched. The final push is fast-forward only and refuses concurrent branch changes. So every pull request that changes what users see adds a line under Unreleased, and the release fails if Unreleased is empty. Add new entries directly under the `## [Unreleased]` heading (not between Unreleased and the last release); that keeps main to dev back-merge conflicts in `CHANGELOG.md` small. On any other branch it does the same as a prerelease (for example `0.1.2-per-edit.1`), committed to that branch, since people who install from a branch get its latest commit. After merging `main` into `per-edit` (or any branch users install from), press Release on that branch before telling users to update. Otherwise the branch head may carry a version string that is already installed, and nobody updates.

## Install (Codex CLI 0.147 or newer)

In a terminal:

```bash
codex plugin marketplace add nlp-research-rosu/intent-check
codex plugin add intent@intentcomputing
```

The Codex IDE extension (VS Code) and the Codex desktop app load the same plugins. Run these commands in a terminal, then restart the extension or app.

Then start `codex` and choose "Trust all and continue" when it says the plugin's hooks need review (or trust them in `/hooks`). Hooks start sign-in through the global CLI when needed; if it is missing, use `onboarding` to install it.

Intent Check 0.2.0 updated its edit hook (it now also runs after `apply_patch` and shell commands in live mode). If Codex lists it as Modified, approve it in `/hooks` (or the app's hook review); the first session after the update says so once.

Codex hooks are plain command strings, so the same `node "${CLAUDE_PLUGIN_ROOT}/bin/hooks.js" ...` line serves every OS.
- Codex cannot wake an idle session, so concerns reach the agent with your next message (or at the end of the same turn, if the check already finished). Clean checks show one short "no concerns" line the next time you prompt.
- Codex does not load plugin slash commands. Ask the agent instead ("turn Intent Check off", "turn live mode on", "run the Intent Check doctor"); it runs the plugin's `hooks.js off`, `live` or `doctor`, which may need your approval to write outside the sandbox. `INTENT_DISABLED=1` when starting Codex also turns checks off.
- To ask for a review, ask the agent to check specific files ("check auth.py with Intent Check"), or for a whole-repo scan, ask for a DeepScan.
- The doctor does not update the plugin on Codex; update it from Codex's plugin list.

## DeepScan

`/intent:deepscan` is the one command for a review on demand (Codex: ask the agent, it runs `hooks.js deepscan`). What it does depends on what you name:

    /intent:deepscan [files or a folder] [fast|balanced|full]

- **Files** (at most 10): the fast review. The request is queued, runs when the turn ends and takes a few minutes; the result arrives as a note. You can also just ask the agent ("check auth.py with Intent Check"). In a project without git, run it from the project root (the folder the session started in).
- **Nothing, or one folder**: a scan of the whole repo, or of that part of it, for behaviour that breaks what the code is meant to do. It runs on the Intent Check service API, so it does not hold up your session. Pick a depth:

| Depth | Takes | Best for |
|---|---|---|
| `fast` (default) | about 15-20 min | the everyday whole-repo scan |
| `balanced` | about 30-35 min | a deeper pass: both models hunt every property |
| `full` | about 40-45 min | the deepest pass, before a release or a handover |

For a whole-repo or folder scan:

- What is sent: a snapshot of the files git tracks plus untracked files that are not ignored, as one compressed upload. Left out: files git ignores, binary files, lockfiles, vendored and generated folders (node_modules, vendor, dist, build, ...), files over 512 KB, and anything that looks like a secrets file. Obvious secrets inside the files are masked first. The limits are 3000 files and 15 MB of text; when a repo is larger, the least relevant files are dropped first and the command says so. Name a folder to scan one part of a big repo.
- DeepScan reads your code, not Intent Check's own `.intent/` results (except `.intent/NOTES.md`).
- The upload is listed in `.intent/.sent.log` (paths and sizes, never contents). Intent Check must be on and signed in; `INTENT_DISABLED=1` stops DeepScan too.
- The command prints the report link and returns. When the scan finishes, a short summary with the top findings appears at your next message in that repo (also in a new session), once. The link shows the full report and live progress.
- Findings are flagged, not reproduced. Ask the agent to reproduce the ones you care about.

Earlier versions had a separate `check` command for files, and `--depth` and `--scope` flags; both are now plain arguments of `deepscan`.

## Development

- Zero runtime dependencies. Plain ESM JavaScript, Node 18 syntax.
- `npm test` (node:test). `npm run test:integration` runs the real `claude -p` and `codex exec` against a mock model API and a fake Intent Check service (no LLM, no secrets; skips a CLI that is not installed); CI runs it on Linux, macOS and Windows. `test/e2e/claude-e2e.sh` drives a real Claude Code session through tmux; `test/e2e/codex-e2e.sh` runs `codex exec` in an isolated `CODEX_HOME`.
- Backend: the Intent Check service API (`nlp-research-rosu/prover`). Its `openapi.yaml` is the contract; `test/helpers/fake-prover.js` mirrors it for tests.
- CLI: `cli/` (Rust). `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`, and the scripts in `cli/tests/` (each takes the binary path).
- `INTENT_DEBUG=1` adds one line per hook call to `intent.log` in the plugin data folder. Test-only: `INTENT_PIPELINE=llm|canned` (honoured only where the server allows overrides), `INTENT_DEEPSCAN_POLL_MS` and `INTENT_DEEPSCAN_BUSY_MS` (waits in tests).
- `NOTICE` lists the Apache-2.0 code this plugin ports from Anthropic's security-guidance plugin.
