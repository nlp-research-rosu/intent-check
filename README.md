# intent-check

The `intent` plugin for Claude Code and Codex provides two explicitly requested workflows:

- **Scan** (`/intent:deepscan`): review named files, a folder or the whole repository.
- **Prove** (`/intent:prove`): formal proofs with K for properties a review cannot settle.

There are no automatic hooks or reviews. Ordinary chats and edits do not capture or upload code, start sign-in, poll jobs or deliver results.

## What is sent, and what stays local

Before starting a remote Scan or Prove operation, the agent explains what will be uploaded to the configured Intent Check service. A local review does not require a remote submission.

- **File Scan:** the named files (at most 10), prior file evidence from `.intent/`, `.intent/NOTES.md` if present, and plugin/host/OS metadata. Files over 1 MB are excluded; content above 1,500 lines is truncated to the first 1,500 lines. Chat prompts, plans, todos and transcripts are not read or uploaded.
- **Repository/folder Scan:** a compressed snapshot of tracked and non-ignored untracked text files, repository metadata and `.intent/NOTES.md`. It excludes other `.intent/` evidence, secrets files, binaries, lockfiles and generated/vendored code. Caps: 512 KB per file, 3,000 files and 15 MB of text. Larger snapshots are trimmed with a coverage notice.
- **Prove:** the program/specification/helper files selected through the explicit CLI commands. See the proof skills and CLI help for their inputs.

Scan masks obvious secrets locally and never sends files such as `.env*`, private keys or credential files. Redaction is not a substitute for reviewing the requested scope. Scan upload metadata is listed in `.intent/.sent.log`; it does not contain source contents.

Project knowledge and evidence under `.intent/` are meant to be committed with source. Transient `.queue`, `.sent.log`, `.storage.lock` and proof-session state stay ignored; do not blanket-ignore `.intent/`.

## Install (Claude Code)

Detailed tool/interface/OS instructions are in [docs/install.json](docs/install.json).

Requirements: Node.js 18+ for Scan commands, and the global `intent-check` CLI for sign-in and Prove.

In Claude Code:

```
/plugin install intent --marketplace nlp-research-rosu/intent-check
```

Or in a terminal:

```bash
claude plugin install intent --marketplace nlp-research-rosu/intent-check
```

This needs Claude Code 2.1.292 or newer. On older versions, run `claude plugin marketplace add nlp-research-rosu/intent-check`, then `claude plugin install intent@intentcomputing`.

Restart Claude Code or run `/reload-plugins`. Use `onboarding` to install the CLI if needed, then run `intent-check login`. Nothing starts automatically after installation.

## Commands

| Command | What it does |
|---|---|
| `/intent:deepscan [files or a folder] [fast\|balanced\|full]` | Submit an explicit remote Scan; return its report link and task ID. |
| `/intent:deepscan collect [task-id]` | Fetch status and save finished Scan results, without submitting source. No ID: outstanding scans in this project. |
| `/intent:prove [what to prove]` | Formal proof with K through the global CLI. |
| `/intent:doctor` | Read connection/configuration diagnostics; does not log in, clear credentials or update the plugin. |

On Codex, ask the agent to invoke the corresponding skill. Scan and diagnostics use `node <plugin>/bin/intent.js`; Prove and login use the global `intent-check` CLI. Network access and plugin-data writes may need sandbox approval.

## Signing in

Run `intent-check login`, open the approval link it prints, and keep the command running until it reports `connected`. Sign-in is explicit. The plugin and CLI share credentials per API origin in `~/.config/intent-check/credentials.json` (`$XDG_CONFIG_HOME/intent-check/`, or `%APPDATA%\intent-check\` on Windows).

For CI, use `INTENT_API_KEY` from the Intent Check console; it takes precedence over saved credentials. Never paste a key into chat.

Endpoint settings are shared in `config.toml` beside credentials: `server_url` selects the API, `portal_url` the console. `INTENT_API_URL` and `INTENT_CONSOLE_URL` override them. The plugin reads TOML through `intent-check config`.

## Prove

`/intent:prove [what to prove]` follows `using-prove` and its proof skills, invoking the global CLI directly. Scan is not a prerequisite. K proofs establish partial correctness: if the program terminates and the precondition holds, the postcondition holds.

Proof inputs and documents live in `.intent/prove/<target>/`; commit them. `.intent/prove/sessions/` is local session state. Commands detect the repository root even from subdirectories; outside Git, they use the project directory. Explicit CLI operations collect their results, with task recovery documented in `intent-check task --help`.

## The `intent-check` command

Install the global CLI once for sign-in, proofs and the local viewer. Releases include macOS, Linux and Windows binaries (x64 and arm64), checksums and installers:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/nlp-research-rosu/intent-check/releases/latest/download/install-intent-check.sh | sh
```

On Windows, download `install-intent-check.ps1` from the same release and run it in PowerShell. Then run `intent-check login`, `intent-check health` and `intent-check semantics`.

## Environment variables

| Variable | Effect |
|---|---|
| `INTENT_API_URL` | API endpoint; default `https://prover.intentcomputing.org`. |
| `INTENT_CONSOLE_URL` | Console endpoint; default `https://prover-console.intentcomputing.org`. |
| `INTENT_API_KEY` | Credential override for the plugin and CLI. |
| `INTENT_DISABLED=1` / `DO_NOT_TRACK=1` | Block plugin Scan commands. These are not switches for the separate proof CLI. |

## Updating

Update the plugin marketplace and plugin, then reload or restart the host. Claude Code: `claude plugin marketplace update intentcomputing`, then `claude plugin update intent@intentcomputing`, then `/reload-plugins`. Codex: `codex plugin marketplace upgrade intentcomputing`, then restart. See [CHANGELOG.md](CHANGELOG.md) for release changes.

Updating does not change an already-running old version or stop its existing workers. Close old sessions and let old workers finish before using the updated plugin. The updated package registers no hooks; cached calls to its retired `bin/hooks.js` are inert. Existing credentials, config, queues, captured sessions and evidence are retained, but old automatic work is not resumed. `INTENT_LIVE` and saved Check `live`/`disabled` choices no longer control explicit Scan commands. Existing DeepScan records can be collected explicitly using their task IDs; already-submitted legacy file reviews remain available through their console links and `intent-check task show <id>`. Old unsubmitted queues are not uploaded.

Claude Code updates a plugin only when its version changes. Third-party marketplace auto-update is optional; enable it under `/plugin` → Marketplaces → intentcomputing. A running session needs `/reload-plugins` or a restart to use a new version.

Maintainers: use the release workflow with a minor bump when removing commands. On `main`, it prepares the version commit from Unreleased, builds CLI assets, publishes the release, then fast-forwards the branch. Other branches publish prereleases. Every user-visible PR needs an Unreleased entry.

## Install (Codex CLI 0.147 or newer)

```bash
codex plugin marketplace add nlp-research-rosu/intent-check
codex plugin add intent@intentcomputing
```

Restart Codex. The desktop app and VS Code extension use the same installed plugins. This plugin has no hooks to approve. Use `onboarding` and explicit `intent-check login` when setup is needed.

## DeepScan

```
/intent:deepscan [files or a folder] [fast|balanced|full]
/intent:deepscan collect [task-id]
```

Named files use the fast file-review API and submit immediately, without waiting for a turn to end. A folder or no path uses repository Scan. Depth applies only to repository/folder scans:

| Depth | Expected time |
|---|---|
| `fast` (default) | 15–20 minutes |
| `balanced` | 30–35 minutes |
| `full` | 40–45 minutes |

Submission prints a report link. Use it to watch progress, or explicitly invoke `collect <task-id>` to fetch status once. Collection saves file-review artifacts under `.intent/<source-path>/` and final repository/folder reports under `.intent/deepscan/<task-id>/report.json`, with task/source metadata in `meta.json`. Report downloads are checked against their stated size and SHA-256. No source contents are copied into the DeepScan evidence folder.

If collection is interrupted or a report is still pending, repeat `collect`; it does not resubmit the scan. Saved reports remain available after service files expire. Supporting files remain remote. Findings are flagged, not reproduced; request reproduction or fixes separately.

## Local HTML viewer

`intent-check view` serves the local evidence viewer on `127.0.0.1` until Ctrl-C. It reads `.intent/` evidence and can display retained legacy Check state, but never submits code or contacts the service. `--project <directory>` selects a project; `--plugin-data <directory>` includes custom legacy state.

`intent-check view --output intent-report.html` exports an offline HTML snapshot without overwriting an existing file. Review evidence before sharing. Credentials, transcripts and source workspaces are not included; symlinks, hidden/temporary/binary files and files over 16 MiB are excluded. Offline exports do not refresh.

## Development

- Zero runtime dependencies; plain ESM JavaScript, Node 18+.
- `npm test` runs existing unit checks. `npm run test:integration` loads the real Claude/Codex plugins against local mock APIs, without paid inference.
- `lib/file-scan.js` handles explicit file submission/collection; `lib/snapshot.js` builds repository snapshots; `lib/deepscan.js` submits and collects repository/folder scans. No host session capture or worker spawning remains.
- Backend contract: the Intent Check service API (`nlp-research-rosu/prover`); `test/helpers/fake-prover.js` provides a controlled service for checks.
- CLI: `cli/` (Rust). CI runs formatting, clippy, build and existing tests.
- `NOTICE` retains attribution for code derived from Anthropic's security-guidance plugin.
