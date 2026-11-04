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
- the project brief and applicable validated requirements under `.intent/`

Obvious secrets (private keys, cloud and API tokens, `KEY=value` lines with random-looking values) are masked on your machine before anything is sent. Files such as `.env*`, `*.pem` and `id_rsa*` are never sent. Tests, styling and markup-only files, generated and vendored code, config and docs are not sent either.

Every upload is listed in `.intent/.sent.log` in your repo (paths, sizes, time, URL; never contents). Everything the plugin writes in your repo goes under `.intent/`, which is meant to be committed; its README explains how to keep it out of git.

Turn it off with `/intent:off` in Claude Code (back on with `/intent:on` or `/intent:live`), or set `INTENT_DISABLED=1` or `DO_NOT_TRACK=1` on either host. While off, nothing is sent.

## Install (Claude Code)

Detailed steps for each tool, interface (desktop app, CLI, VS Code) and OS are in [docs/install.json](docs/install.json). The two sections below are the CLI short form.

Requirements: the global `intent-check` CLI on your `PATH`, with plugin-runtime capabilities. The same goes for Codex. Use the `onboarding` skill to check the installed version against the latest stable release and install or update only when needed and authorized. Hooks never install software.

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

On Codex, ask the agent ("turn live mode on", "run the Intent Check doctor"); it runs `intent-check live`, `on`, `off` or `doctor` with the plugin's host/root identity, which may need your approval to write outside the sandbox. Hooks and detached workers run the native CLI; Node.js is not required.

## Signing in

Use `onboarding` to install the global `intent-check` CLI. Without a key, hooks run `intent-check login` in the background and show its browser approval link, without blocking your task. Concurrent sessions share that login; a later prompt confirms approval once. If the CLI is missing, hooks point to onboarding and never install a private copy. You can also run `intent-check login` yourself: keep it running until it reports `connected`. The CLI saves the key in `~/.config/intent-check/credentials.json` (`$XDG_CONFIG_HOME/intent-check/` when set, `%APPDATA%\intent-check\` on Windows). Keys are stored per API origin. The plugin and command share that file, so you sign in once for both.

In the cloud and in CI, where nobody can open a link, set `INTENT_API_KEY` to a key from the Intent Check console. It takes precedence over the saved key, for the plugin and the command.

The plugin and CLI share endpoint settings in `~/.config/intent-check/config.toml` (the same XDG/Windows directory as credentials). Set `server_url` for the API and `portal_url` for the console. `INTENT_API_URL` and `INTENT_CONSOLE_URL` override them; blank variables count as unset. The plugin reads TOML through the global `intent-check config` command. Plugin preferences such as `disabled` and `live` remain host-local in `config.json`; endpoints do not.

## Prove

`/intent:prove [what to prove]` proves a program correct with K: partial correctness (if it terminates and the precondition holds, the postcondition holds). The agent follows the proof skills (`using-prove` and the skills it points to), calling the global `intent-check` CLI directly. If setup is missing, it uses `onboarding`. On Codex, ask the agent to prove something.

Each operation freezes its uploaded inputs under `.intent/logs/<run-id>/inputs/` and saves `request.json` and `result.json` beside that folder. Use the returned `proofDir` (`logs/<run-id>/artifacts/`) for `SCOPE.md`, `PROOF.md` and `prove.sh`. There is no separate proof store. The session's `.intent/prove/sessions/` is ignored authoring scratch, not proof evidence. `--target path[::symbol]` declares covered source; supporting inputs and `--trusted` claims are not additional verified targets. `--requirement <id>` explicitly associates the submitted formal files with an existing property, not an automatic proof of it. All `.intent/` paths resolve from the detected repository root; outside Git, the CLI uses the project directory.

## Local requirements and evidence

`.intent/REQUIREMENTS.md` is one directly editable project brief. Its initial content is only `# Project requirements` and empty `## Purpose`, `## Expected behavior`, `## Constraints`, `## Out of scope` and `## Open questions` sections. No requirement prose is invented; there is no per-file Markdown or synchronization with JSON. Record actual intent without inventing user confirmation.

The CLI owns structured `requirements.json` writes and derives placement from the targets:

- All targets in one exact source file, including multiple methods: `.intent/source/<source-path>/requirements.json`.
- Targets spanning multiple source files: `.intent/source/requirements.json`.

For example, write this transport payload as `requirement-input.json` (outside the managed `.intent/` paths):

```json
{
  "statement": "Reject negative input prices.",
  "targets": [{"path": "src/pricing.py", "symbol": "calculate_total"}],
  "reason": "Negative prices are invalid."
}
```

```sh
intent-check requirements add --input requirement-input.json
intent-check requirements show <id>
# Edit the transport payload, then replace the record while retaining its ID:
intent-check requirements update <id> --input requirement-input.json
intent-check requirements list
intent-check requirements remove <id>
```

An add stores `.intent/source/src/pricing.py/requirements.json` with a generated ID, for example:

```json
{
  "schema_version": 1,
  "requirements": [
    {
      "id": "k7m2qx",
      "statement": "Reject negative input prices.",
      "targets": [{"path": "src/pricing.py", "symbol": "calculate_total"}],
      "reason": "Negative prices are invalid."
    }
  ]
}
```

Documents require exactly `schema_version` and `requirements`. Records require `id`, `statement` and nonempty `targets`; `reason` is optional. Targets contain an exact repository-relative `path` and optional function/method qualified name `symbol`; omit `symbol` for the whole file. Local requirement, specification bundle and operation IDs contain six lowercase letters/digits, with project-local collision checking; requirement and bundle IDs remain stable on update. Backend task and auth/session IDs are unchanged. If targets change, the CLI relocates the record without duplication and maintains its owning index. Removal detaches its index entry without deleting historical evidence or formal files. `--input` reads a transport payload, not a store destination; add/update have no `--file` scope flag. Requirement commands do not create proof outcomes.

Agents read requirements, specifications, indexes and logs directly with their normal file tools. Request construction collects applicable requirements internally; there is no public context command. Use the CLI for structured requirement mutations and edit `REQUIREMENTS.md` directly. Editing conventions are instructions, not filesystem access restrictions. Internal hook and worker entry points are host lifecycle interfaces, not supported agent-facing commands.

Each source has `source/<source-path>/index.json` and `specs/<spec-id>/` for actual current formal files. The index contains `schema_version: 1` and a `properties` map keyed by requirement ID; each entry has only `specs` (paths relative to `.intent`) and `last_run` (local operation ID or null). A property can have no specs yet; several properties can share files or runs. A cross-file requirement has one owning per-file index, initially its first target; that owner is retained while it remains a target. There is no global index/spec folder.

Operation outputs remain in `logs/<run-id>/artifacts/`. File reviews retain their per-source artifacts there without guessing property associations. Explicit proof associations copy applicable submitted formal files into a new independent bundle and select them in the index. Use `--spec-id <id>` to update or intentionally share an existing bundle, never a matching filename. Relative paths are preserved within each bundle. Copies are not symlinks. Source, requirement, specification and selection versions must still match; late results cannot overwrite newer work. Partial/no-spec output does not delete existing specifications. See [the folder contract](intent-storage.md) for the complete structure. Renamed/deleted source does not rewrite history.

Check/DeepScan outcomes are LLM-reviewed, not formal proof. Successful concrete execution or validation is not proof either. Formal results apply only to selected non-trusted claims under recorded semantics, inputs, controls and assumptions; review soundness and scope separately. Source/input freshness is independent of confidence. Request manifests record exact input hashes and controls, but omit captured prompts/transcripts. Frozen input copies are not included in offline exports.

Submission manifests bind consumed structured requirement IDs and canonical content digests, the source brief digest and the exact redacted context digests. File reviews include only whole requirement records that fit the context limit; excluded IDs and partial brief text are explicitly recorded, never presented as fully submitted records. DeepScan binds the validated context actually included in its snapshot. `--requirement` on a proof is only a versioned local association: requirement prose/records are not uploaded by that flag, and no brief consumption is inferred. The viewer compares those historical bindings with current records independently from source/input freshness; edited or deleted records are stale, and missing or invalid bindings are unknown.

The viewer preserves the typed server proof outcome without inferring per-claim certification from logs or tool exits. Aggregate `proved` may include trusted/admitted claims or cached results. Per-claim non-trusted coverage remains unestablished and proof audit is not recorded by the viewer; inspect the proof workflow's retained audit evidence separately.

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

Both hosts launch the global native CLI through full command strings. Claude hooks read the host-exported plugin root and data environment variables directly, avoiding shell-specific path interpolation; detached children receive that identity as explicit arguments. Codex retains its quoted plugin-root argument.
- Codex cannot wake an idle session, so concerns reach the agent with your next message (or at the end of the same turn, if the check already finished). Clean checks stay silent on Codex.
- Codex does not load plugin slash commands. Ask the agent instead ("turn Intent Check off", "turn live mode on", "run the Intent Check doctor"); it runs `intent-check off`, `live` or `doctor` with the installed plugin identity, which may need your approval to write outside the sandbox. `INTENT_DISABLED=1` when starting Codex also turns checks off.
- To ask for a review, ask the agent to check specific files ("check auth.py with Intent Check"), or for a whole-repo scan, ask for a DeepScan.
- The doctor does not update the plugin on Codex; update it from Codex's plugin list.

## DeepScan

`/intent:deepscan` is the one command for a review on demand (Codex: ask the agent, it runs `intent-check deepscan`). What it does depends on what you name:

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
- DeepScan reads your code, the brief, applicable structured requirements and their selected current formal files. Historical `.intent/` results are not uploaded.
- The upload is listed in `.intent/.sent.log` (paths and sizes, never contents). Intent Check must be on and signed in; `INTENT_DISABLED=1` stops DeepScan too.
- The command prints the report link and returns. When the scan finishes, a short summary with the top findings appears at your next message in that repo (also in a new session), once. The link shows the full report and live progress.
- The plugin saves the final report as `.intent/logs/<run-id>/artifacts/report.json`, after checking its size and SHA-256 against the task response. The six-character local run ID is separate from the backend task ID recorded in the manifest. The operation's `request.json` binds scope, snapshot and per-file hashes; `result.json` records task and report collection status. `source_sha256` identifies local bytes; `submitted_sha256` identifies redacted upload text. The exact uploaded snapshot is retained under `inputs/` and excluded from automatic export.
- Report collection runs in the background and resumes on a later message if interrupted, even after the summary has been delivered. `result.json` distinguishes a saved report from pending, expired or unavailable data. Saved reports are not removed when plugin state or server files expire. Supporting files linked from the report remain on the service; the plugin does not download the sandbox workspace.
- Findings are flagged, not reproduced. Ask the agent to reproduce the ones you care about.

Earlier versions had a separate `check` command for files, and `--depth` and `--scope` flags; both are now plain arguments of `deepscan`.

## Local HTML viewer

Run `intent-check view` from a repository and open the URL it prints. The read-only
viewer listens on `127.0.0.1` until Ctrl-C and refreshes local data every ten seconds.
It displays saved file reviews, DeepScan reports, proof documents and CLI operation
results from `.intent/`, plus queued and submitted file checks. It does not submit
checks, enable per-edit live mode or contact the service. A submitted check means the
plugin is awaiting a result, not that the viewer confirmed its server status.

The repository name comes from Git's `origin` URL, without `.git`, or the root folder
name when no origin is configured. `--project <directory>` selects another repository.
Active file checks are read from Claude Code and Codex plugin data. For an isolated or
custom installation, pass `--plugin-data <directory>` (repeat for multiple hosts).

`intent-check view --output intent-report.html` exports a self-contained offline HTML
snapshot. The file includes the UI, font and local evidence; it needs no account or
network. Existing output files are not overwritten. Review the evidence before sharing
it. Hidden files, symlinks, temporary/binary files and files above 16 MiB are excluded;
skipped symlinks and oversized files are listed in the viewer. Only known evidence/requirements formats and paths are selected. Plugin session prompts,
transcripts, credentials, scratch workspaces and frozen input source copies are not embedded. Source freshness is observed when the snapshot is read; an offline export does not recheck it. DeepScan
supporting files remain remote. Offline exports do not refresh.

## Development

- The native Rust CLI owns hooks, capture, reviews, DeepScan and detached workers. Browser JavaScript powers the local viewer; Node.js is only needed for development tooling.
- `npm test` (node:test). Ordinary CI runs `npm run test:smoke` on Linux. `npm run test:integration` runs the real `claude -p` and `codex exec` against a mock model API and a fake Intent Check service (no LLM, no secrets; skips a CLI that is not installed); release/manual workflows run it on Linux, macOS and Windows. `test/e2e/claude-e2e.sh` drives a real Claude Code session through tmux; `test/e2e/codex-e2e.sh` runs `codex exec` in an isolated `CODEX_HOME`.
- Backend: the Intent Check service API (`nlp-research-rosu/prover`). Its `openapi.yaml` is the contract; `test/helpers/fake-prover.js` mirrors it for tests.
- CLI: `cli/` (Rust). `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`, and the scripts in `cli/tests/` (each takes the binary path).
- `INTENT_DEBUG=1` adds one line per hook call to `intent.log` in the plugin data folder. Test-only: `INTENT_PIPELINE=llm|canned` (honoured only where the server allows overrides), `INTENT_DEEPSCAN_POLL_MS` and `INTENT_DEEPSCAN_BUSY_MS` (waits in tests).
- `NOTICE` lists the Apache-2.0 code this plugin ports from Anthropic's security-guidance plugin.
