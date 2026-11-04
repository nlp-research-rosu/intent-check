# Intent Prover

The `intent` plugin for Claude Code and Codex, powered by the global `intent-prover` CLI. One agent skill coordinates four capabilities:

- **Formalize**: clarify and record intended behavior (`/intent:formalize`).
- **Review**: check changed or selected code against requirements (`/intent:review`).
- **Scan**: investigate broader repository or folder behavior (`/intent:scan`).
- **Prove**: establish formal claims with K under explicit assumptions (`/intent:prove`).

On, Live and Off control automatic Review timing and enablement; they are not separate capabilities.

Status: private pre-release, under construction.

## When it checks

Automatically, after each turn that changes code with logic (functions, state, calculations) by at least 3 lines. It skips styling, markup-only files, tests, config and vendored code. To review on demand, ask the agent ("review pricing.py") or run `/intent:review <files>`.

## What is sent, and what stays local

After a turn that changes source files, the plugin sends to the Intent Prover service:

- your last few prompts in the session (and the first one), the approved plan and todo items, and the agent's final message for the turn
- the diff of each changed source file and the file itself (large files: only the changed regions)
- the plugin version, host, OS and permission mode
- the project brief and applicable validated requirements under `.intent/`

Obvious secrets (private keys, cloud and API tokens, `KEY=value` lines with random-looking values) are masked on your machine before anything is sent. Files such as `.env*`, `*.pem` and `id_rsa*` are never sent. Tests, styling and markup-only files, generated and vendored code, config and docs are not sent either.

Every upload is listed in `.intent/.sent.log` in your repo (paths, sizes, time, URL; never contents). Everything the plugin writes in your repo goes under `.intent/`, which is meant to be committed; its README explains how to keep it out of git.

Turn it off with `/intent:off` in Claude Code (back on with `/intent:on` or `/intent:live`), or set `INTENT_DISABLED=1` or `DO_NOT_TRACK=1` on either host. While off, nothing is sent.

## Install (Claude Code)

Detailed steps for each tool, interface (desktop app, CLI, VS Code) and OS are in [docs/install.json](docs/install.json). The two sections below are the CLI short form.

Requirements: the global `intent-prover` CLI on your `PATH`, with plugin-runtime capabilities. The same goes for Codex. Use the [skill setup reference](skills/intent-prover/references/setup.md) to check the installed version against the latest stable release and install or update only when needed and authorized. Hooks never install software.

In a Claude Code session, type:

```
/plugin install intent --marketplace nlp-research-rosu/intent-check
```

It asks you to confirm the source, then installs. Or, in a terminal:

```bash
claude plugin install intent --marketplace nlp-research-rosu/intent-check
```

This needs Claude Code 2.1.292 or newer. On an older version, run `claude plugin marketplace add nlp-research-rosu/intent-check` and then `claude plugin install intent@intentcomputing`.

Then restart Claude Code or run `/reload-plugins`. If the global CLI is installed, hooks show a browser sign-in link automatically. Otherwise ask the agent to follow the skill setup reference to install it. Approve the link to enable checks; your task can continue while sign-in is pending. If anything looks wrong later, run `/intent:doctor`. See [Signing in](#signing-in).

## Commands

| Command | What it does |
|---|---|
| `/intent:formalize [behavior]` | Clarify consequential choices and record requirements. |
| `/intent:review [files]` | Queue a Review of selected files at turn end. |
| `/intent:on` | Enable Review at the end of each turn. |
| `/intent:live` | Also enable Review after edits. |
| `/intent:off` | Nothing is sent until `/intent:on` or `/intent:live`. |
| `/intent:scan [folder] [fast\|balanced\|full]` | Investigate a repository or folder. See [Scan](#scan). |
| `/intent:prove [what to prove]` | Formal proof with K. See [Prove](#prove). |
| `/intent:doctor` | Shows the plugin's state and repairs what it can. See below. |

**On and Live.** On enables Review at turn end. Live adds Review after edits: each Edit, Write, MultiEdit or Codex `apply_patch` is sent on its own, and files written through shell commands (`Bash`) are found against the git baseline at turn start. Available concerns reach the agent at a later hook event. Files already covered by a live review are not submitted again at turn end. `/intent:on` returns to end-of-turn timing only.

Claude Code's asynchronous Stop hook can resume the agent with concerns, within its wait budget and loop/rate guards. Codex can block Stop with already-available concerns, but cannot independently wake an idle agent; later results arrive at a subsequent hook event. Submission does not guarantee automatic continuation on both hosts.

The choice is saved in the plugin's `config.json` as `live`. `INTENT_LIVE=1` or `0` in the environment overrides it, which is useful where the plugin's data folder is not writable.

**Doctor.** `/intent:doctor` prints the version, the service, the account, whether checks are on, the last check and the last error, and then repairs what it can:

- Not signed in: it points to setup and `intent-prover login`.
- The service no longer accepts the saved key: it forgets the key and asks you to run `intent-prover login` again.
- A newer release: the first line names it ("v0.2.3 (v0.2.4 available)"). It reads the release tags of the marketplace the plugin was installed from, so it also works where the plugin cannot update itself.
- An update: on Claude Code it runs `claude plugin marketplace update` and `claude plugin update` for you, and tells you to run `/reload-plugins` when a new version was installed. Where the `claude` command is not available (the desktop app, for example) it says how to update by hand.
- Anything only you can fix (checks turned off, an environment variable, no network) is listed as a "To do" line.

To revoke a machine's key, use the Intent Prover console. Uninstalling the plugin does not remove the saved key, because the `intent-prover` command shares it; delete `credentials.json` (see below) to sign out.

On Codex, ask the agent ("enable Review after edits", "run the Intent Prover doctor"); it runs `intent-prover live`, `on`, `off` or `doctor` with the plugin's host/root identity, which may need your approval to write outside the sandbox. Hooks and detached workers run the native CLI; Node.js is not required.

## Signing in

Use the [setup reference](skills/intent-prover/references/setup.md) to install the global `intent-prover` CLI. Without a key, hooks run `intent-prover login` in the background and show its browser approval link, without blocking your task. Concurrent sessions share that login; a later prompt confirms approval once. You can also run `intent-prover login` yourself: keep it running until it reports `connected`. The CLI saves the key in `~/.config/intent-prover/credentials.json` (`$XDG_CONFIG_HOME/intent-prover/` when set, `%APPDATA%\intent-prover\` on Windows). Keys are stored per API origin. The plugin and command share that file, so you sign in once for both.

In the cloud and in CI, where nobody can open a link, set `INTENT_API_KEY` to a key from the Intent Prover console. It takes precedence over the saved key, for the plugin and the command.

The plugin and CLI share endpoint settings in `~/.config/intent-prover/config.toml` (the same XDG/Windows directory as credentials). Set `server_url` for the API and `portal_url` for the console. `INTENT_API_URL` and `INTENT_CONSOLE_URL` override them; blank variables count as unset. The plugin reads TOML through the global `intent-prover config` command. Plugin preferences such as `disabled` and `live` remain host-local in `config.json`; endpoints do not.

## Prove

`/intent:prove [what to prove]` establishes partial correctness with K: if the precondition holds and the program terminates, the postcondition holds. The single `intent-prover` skill loads [Prove guidance](skills/intent-prover/references/prove.md), with optional `prove-specifications`, `prove-evidence` and `prove-diagnostics` references. On Codex, ask the agent to prove something.

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
intent-prover requirements add --input requirement-input.json
intent-prover requirements show <id>
# Edit the transport payload, then replace the record while retaining its ID:
intent-prover requirements update <id> --input requirement-input.json
intent-prover requirements list
intent-prover requirements remove <id>
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

Review/Scan outcomes are LLM-reviewed, not formal proof. Successful concrete execution or validation is not proof either. Formal results apply only to selected non-trusted claims under recorded semantics, inputs, controls and assumptions; review soundness and scope separately. Source/input freshness is independent of confidence. Request manifests record exact input hashes and controls, but omit captured prompts/transcripts. Frozen input copies are not included in offline exports.

Submission manifests bind consumed structured requirement IDs and canonical content digests, the source brief digest and the exact redacted context digests. File reviews include only whole requirement records that fit the context limit; excluded IDs and partial brief text are explicitly recorded, never presented as fully submitted records. Scan binds the validated context actually included in its snapshot. `--requirement` on a proof is only a versioned local association: requirement prose/records are not uploaded by that flag, and no brief consumption is inferred. The viewer compares those historical bindings with current records independently from source/input freshness; edited or deleted records are stale, and missing or invalid bindings are unknown.

The viewer preserves the typed server proof outcome without inferring per-claim certification from logs or tool exits. Aggregate `proved` may include trusted/admitted claims or cached results. Per-claim non-trusted coverage remains unestablished and proof audit is not recorded by the viewer; inspect the proof workflow's retained audit evidence separately.

## The `intent-prover` command

### Local LSP symbol graph

Configure already-installed language servers in the global `intent-prover/config.toml`:

```toml
[lsp.pyright]
command = ["pyright-langserver", "--stdio"]
extensions = [".py", ".pyi"]
language_id = "python"
root_markers = ["pyrightconfig.json", "pyproject.toml"]

[lsp.pyright.settings.python.analysis]
diagnosticMode = "workspace"
```

Once configured, no graph command is needed. While Intent Prover is enabled, its native
SessionStart and Stop hooks schedule local background collection. The worker discovers
matching source files, reuses an unchanged successful snapshot, or starts each relevant
server/project root to discover symbols, incoming/outgoing calls and symbol references.
Servers stop after collection. There is no public LSP command, watcher or persistent daemon.

Commands in configuration are executable/argument arrays, not shell expressions;
servers run with your permissions. Missing executables are reported in the private plugin
`intent.log`, never installed automatically. Optional `env`, `initialization` and `settings`
tables customize each server; `disabled = true` disables it. See `intent-prover config --help`.

The native Intent CLI does not require Node, but optional analyzers have their own
runtime and project requirements:

| Analyzer | Local requirements |
| --- | --- |
| Python / Pyright | Node and Pyright; a project Python environment helps resolve imports. |
| JavaScript/TypeScript / typescript-language-server | Node, the language server and a compatible TypeScript package. |
| Go / gopls | The Go toolchain as well as gopls; the server invokes `go` to load projects. |
| Rust / rust-analyzer | For normal Cargo projects, Rust/Cargo and standard-library sources; build scripts and procedural macros may require compilation. |

Reuse installed tools where possible. Analyzer setup and project loading can download
dependencies, toolchains or standard-library sources. Restricted networks may require
mirrors, a proxy or a VPN; preinstalled tools and populated dependency caches can reduce
that need. Collection is optional and other Intent operations continue without it.

Results replace `.intent/graph.json` with readable symbols, calls and references:

```json
{
  "symbols": {
    "checkout.py:checkout": {"name": "checkout", "kind": "function", "file": "checkout.py", "line": 3, "end_line": 5},
    "pricing.py:discount": {"name": "discount", "kind": "function", "file": "pricing.py", "line": 1, "end_line": 2},
    "pricing.py:TAX_RATE": {"name": "TAX_RATE", "kind": "constant", "file": "pricing.py", "line": 4, "end_line": 4}
  },
  "calls": [
    {"caller": "checkout.py:checkout", "callee": "pricing.py:discount", "file": "checkout.py", "line": 4}
  ],
  "references": [
    {"from": "checkout.py:checkout", "to": "pricing.py:TAX_RATE", "file": "checkout.py", "line": 5, "column": 12, "end_line": 5, "end_column": 20}
  ]
}
```

Lines are 1-based and implementation spans are inclusive. Methods use analyzer-reported
containers, such as `checkout.py:Cart.total`; repeated names include an `@line:column`
suffix (1-based UTF-16 column). Calls to the same target on the same source line are
combined. Symbols preserve all standard LSP kinds, including functions, classes,
structs, interfaces, enums, properties, fields, variables and constants.
Function-local variables/constants
are excluded when the server reports their enclosing callable. References use `to` for
the referenced symbol and optional `from` for the innermost enclosing symbol; module-level
uses without an enclosing symbol retain their file/location. Reference ranges use 1-based
UTF-16 columns and an exclusive end position, preserving separate uses on the same line.
Declarations are excluded by the reference query. Call-hierarchy queries target only
functions, methods and constructors; reference queries target variables, constants,
fields and properties. References do not classify
reads versus writes. Source/config hashes and snapshot identity stay in private global LSP state;
analyzer details, timings and omitted symbols stay in the private plugin log, not the graph.
The collector uses advertised capabilities independently. Unsupported relationship
capabilities and rejected relationship queries produce explicit partial results;
they are not cached as successful empty traces.
Standard work-done progress delays queries while reported work is active, waiting up to
30 seconds for work to settle with a 200 ms quiet interval. The wait is interruptible.
If work starts during collection, the worker discards that server's results and retries
once on the same connection after work settles. Continued work or a timeout prevents
successful caching. Progress is optional; its absence or completion does not establish
universal workspace readiness.
Partial collections add `status: "partial"` and `issues`; successful graphs contain only
`symbols`, `calls` and `references`. Collections with no completed files or changing
sources preserve the previous graph. Failures do not block hooks or source reviews;
inspect `lsp.finished`/`lsp.failed` in the private plugin log. Concurrent refreshes are
skipped; later hooks can retry. Relationships are analyzer-reported static context, not
proof or guaranteed runtime calls. External targets are omitted; external environment
and analyzer-binary changes are not freshness-verified. LSP collection needs no sign-in
and its graph is not uploaded or attached to Review/Scan. Python/Pyright is the initial
integration; other servers need document-symbol support. Call-hierarchy and references
capabilities provide their respective edges; absent capabilities are reported as partial context.

### CLI installation

Install the global CLI once for both skills and terminal use. The plugin package contains skills and native hook registrations, not a native executable or private binary cache. Each release has the Rust binary for macOS, Linux and Windows (x64 and arm64), with checksums, and an installer:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/nlp-research-rosu/intent-check/releases/latest/download/install-intent-prover.sh | sh
```

On Windows, download `install-intent-prover.ps1` from the same release and run it in PowerShell. Then run `intent-prover login`, `intent-prover health` and `intent-prover semantics`.

### Migrating from Intent Check

The executable is now `intent-prover`, with no `intent-check` alias. Stop or finish old CLI workers before migration. The installer verifies the replacement and runs `intent-prover migrate` offline, moving configuration, credentials, sessions and cached state to the sibling `intent-prover` directory. Conflicting entries stop migration without overwriting them. File permissions are retained. Legacy PATH-only environment files stay in place; `.intent` project data and `intent` host plugin data are unchanged.

After verifying the new CLI, remove the identified old installation. For a binary installed by the old checksum-verifying installer, authorize cleanup with `INTENT_PROVER_REMOVE_LEGACY=1` in the Unix installer's environment or `-RemoveLegacy` in PowerShell. Cleanup requires the adjacent `.intent-check.sha256` marker to match the old executable; other installations use their original uninstall method. Do not remove configuration or project data. See [setup](skills/intent-prover/references/setup.md).

## Environment variables

| Variable | Effect |
|---|---|
| `INTENT_API_URL` | The Intent Prover service API the plugin and the CLI talk to (default `https://prover.intentcomputing.org`). |
| `INTENT_CONSOLE_URL` | The Intent Prover console that sign-in and result links open in, for the plugin and the CLI. |
| `INTENT_API_KEY` | The API key, instead of the saved one, for the plugin and the CLI. For cloud sessions and CI. |
| `INTENT_DISABLED=1` | Turns the plugin off; nothing is sent. |
| `DO_NOT_TRACK=1` | The same. |
| `INTENT_LIVE=1` or `0` | Sets Review after edits, overriding the saved choice. |

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

Then start `codex` and choose "Trust all and continue" when it says the plugin's hooks need review (or trust them in `/hooks`). Hooks start sign-in through the global CLI when needed; if it is missing, use the skill setup reference to install it.

If Codex lists an updated hook as Modified, approve it in `/hooks` (or the app's hook review); the first session after an update shows a reminder.

Both hosts launch the global native CLI through full command strings. Claude hooks read the host-exported plugin root and data environment variables directly, avoiding shell-specific path interpolation; detached children receive that identity as explicit arguments. Codex retains its quoted plugin-root argument.
- Codex cannot wake an idle session, so concerns reach the agent with your next message (or at the end of the same turn, if the check already finished). Clean checks stay silent on Codex.
- Codex does not load plugin slash commands. Ask the agent instead ("turn Intent Prover off", "enable Review after edits", "run the Intent Prover doctor"); it runs `intent-prover off`, `live` or `doctor` with the installed plugin identity, which may need your approval to write outside the sandbox. `INTENT_DISABLED=1` when starting Codex also turns checks off.
- To ask for a Review, name specific files ("review auth.py with Intent Prover"); for a repository investigation, ask for a Scan.
- The doctor does not update the plugin on Codex; update it from Codex's plugin list.

## Scan

Use `/intent:scan` for a repository or folder investigation (Codex: ask the agent to run `intent-prover scan`):

    /intent:scan [folder] [fast|balanced|full]

- **Files** (at most 10): use `/intent:review <files>` or `intent-prover review <files>`. File arguments to `scan` also route to queued Review at turn end. Outside git, run Review from the project root.
- **Nothing, or one folder**: Scan the whole repository or that folder for behavior that breaks requirements. The service runs it in the background. Pick a depth:

| Depth | Takes | Best for |
|---|---|---|
| `fast` (default) | about 15-20 min | the everyday whole-repo scan |
| `balanced` | about 30-35 min | a deeper pass: both models hunt every property |
| `full` | about 40-45 min | the deepest pass, before a release or a handover |

For a whole-repo or folder scan:

- What is sent: a snapshot of the files git tracks plus untracked files that are not ignored, as one compressed upload. Left out: files git ignores, binary files, lockfiles, vendored and generated folders (node_modules, vendor, dist, build, ...), files over 512 KB, and anything that looks like a secrets file. Obvious secrets inside the files are masked first. The limits are 3000 files and 15 MB of text; when a repo is larger, the least relevant files are dropped first and the command says so. Name a folder to scan one part of a big repo.
- Scan reads your code, the brief, applicable structured requirements and their selected current formal files. Historical `.intent/` results are not uploaded.
- The upload is listed in `.intent/.sent.log` (paths and sizes, never contents). Intent Prover must be on and signed in; `INTENT_DISABLED=1` stops Scan too.
- The command prints the report link and returns. When the scan finishes, a short summary with the top findings appears at your next message in that repo (also in a new session), once. The link shows the full report and live progress.
- The plugin saves the final report as `.intent/logs/<run-id>/artifacts/report.json`, after checking its size and SHA-256 against the task response. The six-character local run ID is separate from the backend task ID recorded in the manifest. The operation's `request.json` binds scope, snapshot and per-file hashes; `result.json` records task and report collection status. `source_sha256` identifies local bytes; `submitted_sha256` identifies redacted upload text. The exact uploaded snapshot is retained under `inputs/` and excluded from automatic export.
- Report collection runs in the background and resumes on a later message if interrupted, even after the summary has been delivered. `result.json` distinguishes a saved report from pending, expired or unavailable data. Saved reports are not removed when plugin state or server files expire. Supporting files linked from the report remain on the service; the plugin does not download the sandbox workspace.
- Findings are flagged, not reproduced. Ask the agent to reproduce the ones you care about.

Use the public `scan` command; scope and depth are positional arguments.

## Local HTML viewer

Run `intent-prover view` from a repository and open the URL it prints. The read-only
viewer listens on `127.0.0.1` until Ctrl-C and refreshes local data every ten seconds.
It displays saved file reviews, Scan reports, proof documents and CLI operation
results from `.intent/`, plus queued and submitted file checks. It does not submit
checks, enable Review after edits or contact the service. A submitted check means the
plugin is awaiting a result, not that the viewer confirmed its server status.

The repository name comes from Git's `origin` URL, without `.git`, or the root folder
name when no origin is configured. `--project <directory>` selects another repository.
Active file checks are read from Claude Code and Codex plugin data. For an isolated or
custom installation, pass `--plugin-data <directory>` (repeat for multiple hosts).

`intent-prover view --output intent-report.html` exports a self-contained offline HTML
snapshot. The file includes the UI, font and local evidence; it needs no account or
network. Existing output files are not overwritten. Review the evidence before sharing
it. Hidden files, symlinks, temporary/binary files and files above 16 MiB are excluded;
skipped symlinks and oversized files are listed in the viewer. Only known evidence/requirements formats and paths are selected. Plugin session prompts,
transcripts, credentials, scratch workspaces and frozen input source copies are not embedded. Source freshness is observed when the snapshot is read; an offline export does not recheck it. Scan
supporting files remain remote. Offline exports do not refresh.

## Development

- The native Rust CLI owns hooks, capture, Review, Scan and detached workers. Browser JavaScript powers the local viewer; Node.js is only needed for development tooling.
- `npm test` (node:test). Ordinary CI runs `npm run test:smoke` on Linux. `npm run test:integration` runs the real `claude -p` and `codex exec` against a mock model API and a fake Intent Prover service (no LLM, no secrets; skips a CLI that is not installed); release/manual workflows run it on Linux, macOS and Windows. `test/e2e/claude-e2e.sh` drives a real Claude Code session through tmux; `test/e2e/codex-e2e.sh` runs `codex exec` in an isolated `CODEX_HOME`.
- Backend: the Intent Prover service API (`nlp-research-rosu/prover`). Its `openapi.yaml` is the contract; `test/helpers/fake-prover.js` mirrors it for tests.

Maintain the short general **What's new** section in `skills/intent-prover/SKILL.md`
with each release: current features, changed behavior, deprecations and required
actions. Keep detailed setup/migration in its reference rather than the entry skill.
- CLI: `cli/` (Rust). `cargo fmt --check`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`, and the scripts in `cli/tests/` (each takes the binary path).
- `INTENT_DEBUG=1` adds one line per hook call to `intent.log` in the plugin data folder. Test-only: `INTENT_PIPELINE=llm|canned` (honoured only where the server allows overrides), `INTENT_DEEPSCAN_POLL_MS` and `INTENT_DEEPSCAN_BUSY_MS` (waits in tests).
- `NOTICE` lists the Apache-2.0 code this plugin ports from Anthropic's security-guidance plugin.
