# Intent Prover

The `intent` plugin for Claude Code and Codex provides two explicitly requested workflows:

- **Scan** (`/intent:scan`): analyze a file, a folder or the whole repository.
- **Prove** (`/intent:prove`): formal proofs with K for properties a review cannot settle.

There are no automatic hooks or reviews. Ordinary chats and edits do not capture or upload code, start sign-in, poll jobs or deliver results.

## What is sent, and what stays local

Before starting a remote Scan or Prove operation, the agent explains what will be uploaded to the configured Intent Prover service. A local review does not require a remote submission.

- **Scan:** a compressed snapshot of tracked and non-ignored untracked text files within the selected file, folder or repository, plus repository metadata. `.intent/NOTES.md` is included when it falls within the selected scope. It excludes other `.intent/` evidence, secrets files, binaries, lockfiles and generated/vendored code. Caps: 512 KB per file, 3,000 files and 15 MB of text. Larger snapshots are trimmed with a coverage notice. Chat prompts, plans, todos and transcripts are not read or uploaded.
- **Prove:** the program/specification/helper files selected through the explicit CLI commands. See the proof skills and CLI help for their inputs.

Scan masks obvious secrets locally and never sends files such as `.env*`, private keys or credential files. Redaction is not a substitute for reviewing the requested scope. Scan upload metadata is listed in `.intent/.sent.log`; it does not contain source contents.

Project knowledge and evidence under `.intent/` are meant to be committed with source. Transient `.queue`, `.sent.log`, `.storage.lock` and proof-session state stay ignored; do not blanket-ignore `.intent/`.

## Install (Claude Code)

Requirements: Node.js 18+ for Scan commands, and the global `intent-prover` CLI for sign-in and Prove.

In Claude Code:

```
/plugin install intent --marketplace nlp-research-rosu/intent-prover
```

Or in a terminal:

```bash
claude plugin install intent --marketplace nlp-research-rosu/intent-prover
```

This needs Claude Code 2.1.292 or newer. On older versions, run `claude plugin marketplace add nlp-research-rosu/intent-prover`, then `claude plugin install intent@intentcomputing`.

Restart Claude Code or run `/reload-plugins`. Use the Intent Prover skill's onboarding guide to install the CLI if needed, then run `intent-prover login`. Nothing starts automatically after installation.

## Commands

| Command | What it does |
|---|---|
| `/intent:scan [file or folder] [fast\|balanced\|full]` | Submit a Scan, wait for completion, save evidence and return findings. |
| `/intent:scan collect [task-id]` | Resume an interrupted Scan without submitting source. No ID: outstanding scans in this project. |
| `/intent:prove [what to prove]` | Formal proof with K through the global CLI. |
| `/intent:doctor` | Read connection/configuration diagnostics; does not log in, clear credentials or update the plugin. |

On Codex, ask the agent to invoke the corresponding skill. Scan and diagnostics use `node <plugin>/bin/intent.js`; Prove and login use the global `intent-prover` CLI. Network access and plugin-data writes may need sandbox approval.

## Signing in

Run `intent-prover login`, open the approval link it prints, and keep the command running until it reports `connected`. Sign-in is explicit. The plugin and CLI share credentials per API origin in `~/.config/intent-prover/credentials.json` (`$XDG_CONFIG_HOME/intent-prover/`, or `%APPDATA%\intent-prover\` on Windows).

For CI, use `INTENT_API_KEY` from the Intent Prover console; it takes precedence over saved credentials. Never paste a key into chat.

Endpoint settings are shared in `config.toml` beside credentials: `server_url` selects the API, `portal_url` the console. `INTENT_API_URL` and `INTENT_CONSOLE_URL` override them. The plugin reads TOML through `intent-prover config`.

## Prove

The single `intent-prover` skill contains onboarding, Scan and Prove guides, with detailed references loaded only as needed. `/intent:prove [what to prove]` follows its Prove guide, invoking the global CLI directly. Scan is not a prerequisite. K proofs establish partial correctness: if the program terminates and the precondition holds, the postcondition holds. Writing or auditing new language semantics is not included.

Proof inputs and documents live in `.intent/prove/<target>/`; commit them. `.intent/prove/sessions/` is local session state. Commands detect the repository root even from subdirectories; outside Git, they use the project directory. Explicit CLI operations collect their results, with task recovery documented in `intent-prover task --help`.

## The `intent-prover` command

Install the global CLI once for sign-in, proofs and the local viewer. Releases include macOS, Linux and Windows binaries (x64 and arm64), checksums and installers:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/nlp-research-rosu/intent-prover/releases/latest/download/install-intent-prover.sh | sh
```

On Windows, download `install-intent-prover.ps1` from the same release and run it in PowerShell. Then run `intent-prover login`, `intent-prover health` and `intent-prover semantics`.

## Environment variables

| Variable | Effect |
|---|---|
| `INTENT_API_URL` | API endpoint; default `https://api.prover.intentcomputing.org`. |
| `INTENT_CONSOLE_URL` | Console endpoint; default `https://prover-console.intentcomputing.org`. |
| `INTENT_API_KEY` | Credential override for the plugin and CLI. |
| `INTENT_DISABLED=1` / `DO_NOT_TRACK=1` | Block plugin Scan commands. These are not switches for the separate proof CLI. |

## Updating

Update the plugin marketplace and plugin, then reload or restart the host. Claude Code: `claude plugin marketplace update intentcomputing`, then `claude plugin update intent@intentcomputing`, then `/reload-plugins`. Codex: `codex plugin marketplace upgrade intentcomputing`, then restart. See [CHANGELOG.md](CHANGELOG.md) for release changes.

Reload or restart the host after updating. The plugin has no hook entrypoint or compatibility layer. Collect submitted Scans using their task IDs; other submitted tasks remain available through their console links and `intent-prover task show <id>`.

Claude Code updates a plugin only when its version changes. Third-party marketplace auto-update is optional; enable it under `/plugin` → Marketplaces → intentcomputing. A running session needs `/reload-plugins` or a restart to use a new version.

The shared marketplace pins the plugin source to a published tag and exact commit for both Claude Code and Codex. Merging code into a branch does not advertise it as a plugin update. Fresh installs and host updates use the release named by the marketplace, not the checkout's development files.

Maintainers: use the release workflow to choose the source branch, channel and exact version (for example `1.3.0` or `1.3.0-staging.1`). Versions are entered manually, not automatically incremented. The workflow prepares the matching plugin/CLI package, builds and uploads all CLI assets, then publishes the release before advancing its catalog. Production releases run from `main`; staging releases update only their separate catalog, not the source branch or production installer/catalog. Concurrent catalog changes prevent a non-fast-forward push. Every user-visible PR needs an Unreleased entry in [CHANGELOG.md](CHANGELOG.md).

## Install (Codex CLI 0.147 or newer)

```bash
codex plugin marketplace add nlp-research-rosu/intent-prover
codex plugin add intent@intentcomputing
```

Restart Codex. The desktop app and VS Code extension use the same installed plugins. This plugin has no hooks to approve. Use the Intent Prover skill's onboarding guide and explicit `intent-prover login` when setup is needed.

## Scan

```
/intent:scan [file or folder] [fast|balanced|full]
/intent:scan collect [task-id]
```

Run from inside a Git repository. With no path, Scan snapshots the repository; one file or folder limits the snapshot to that path. Every submission uses `POST /scan`. Choose a depth:

| Depth | Expected time |
|---|---|
| `fast` (default) | 15–20 minutes |
| `balanced` | 30–35 minutes |
| `full` | 40–45 minutes |

The command prints a report link, then polls until the task finishes, saves its evidence and returns findings. Keep it running, as with Prove. Polling uses the shared `poll_interval_seconds` setting (default 10 seconds); transient status-request failures retry after 1, 2 and 4 seconds. No detached worker or later-message hook is involved. Collection saves reports under `.intent/scan/<task-id>/report.json`, with task/source metadata in `meta.json`. Report downloads are checked against their stated size and SHA-256. No source contents are copied into the Scan evidence folder.

This plugin requires the service's `POST /scan` contract and `scan` task kind. It uses `.intent/scan/` for evidence and `scans/` for task records. Older folders are left untouched and are not read by collection or the viewer.

Interrupting Scan stops local waiting; the remote task may continue. If interrupted, polling fails or a report is still pending, use `collect <task-id>` to resume waiting and collection; it does not resubmit the scan. Saved reports remain available after service files expire. Supporting files remain remote. Findings are flagged, not reproduced; request reproduction or fixes separately.

## Local HTML viewer

`intent-prover view` serves the local evidence viewer on `127.0.0.1` until Ctrl-C. It reads `.intent/` evidence and explicit Scan records, but never submits code or contacts the service. `--project <directory>` selects a project; `--plugin-data <directory>` selects a custom plugin data directory.

`intent-prover view --output intent-report.html` exports an offline HTML snapshot without overwriting an existing file. Review evidence before sharing. Credentials, transcripts and source workspaces are not included; symlinks, hidden/temporary/binary files and files over 16 MiB are excluded. Offline exports do not refresh.

After a requested Scan or Prove workflow, the agent exports this viewer and hands
off one local HTML link with a short outcome, scope and limitations summary.
Prove first writes or updates `.intent/prove/<target>/PROOF.md` and `SCOPE.md`;
the viewer renders those documents rather than generating a proof narrative.
If export is unavailable, the agent reports that limitation and supplies saved
evidence instead. No sign-in or network is needed to export or read local HTML.

Each saved Scan includes an **Open job in Prover** link. New proof, validation and
run submissions also save their console job URL as `reportUrl` beside `task` in
`result.json`; the viewer links these jobs from verification runs. These URLs
retain the submission's console, including staging or a custom console path,
even if configuration later changes. Existing evidence without a saved URL is
still readable; the viewer does not guess its remote environment. Remote job
pages may require sign-in, and Scan supporting detail files remain remote.

Reports support direct local navigation: append
`#view=scans&scan=scan%2F<task-id>%2Fmeta.json` for a Scan, or
`#view=proofs&proof=prove%2F<target>%2F&proofTab=report` for a proof report.
URL-encode any additional path characters. HTML presentation does not turn Scan
findings into formal proof or add assurance to a proof's recorded claims.

## Development

- Zero runtime dependencies; plain ESM JavaScript, Node 18+.
- `npm test` checks core Scan behavior, repository-root evidence, upload safety and corrupt-report retention. The three `cli/tests/check-cli-*.py` scripts check the built CLI for run/validate/prove, failure results, retry identity, each operation's attempt limit, input boundaries, repository-root evidence, offline HTML, login and Ctrl-C. `npm run test:integration` checks that loading each real Claude/Codex plugin does not automatically submit code, using local mock APIs without paid inference. These checks do not replace a real Scan/Prove smoke check before release.
- Ordinary CI runs the core checks on Linux with Node 22, plus native CLI checks. Relevant plugin changes also run both host checks on Linux. Release/manual host checks use Linux too; native release binaries still build for all six platform/architecture targets.
- `lib/snapshot.js` builds scoped repository snapshots; `lib/scan.js` submits, waits for and collects Scans. No host session capture or worker spawning remains.
- Backend contract: the Intent Prover service API (`nlp-research-rosu/prover`); `test/helpers/fake-prover.js` provides a controlled service for checks.
- CLI: `cli/` (Rust). CI runs formatting, clippy, build and existing tests.
