# Changelog

What changed for people who use the plugin, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor bump (0.2 to 0.3) can remove or rename commands.

Maintainers: add a line under Unreleased in the same pull request as the change. The release workflow gives that section the version number and uses it as the release notes.

## [Unreleased]

### Changed

- The default API endpoint is now `https://api.prover.intentcomputing.org`. A key saved for the previous default keeps working, so signing in again is not needed.

## [1.1.0] - 2026-11-06

### Removed

- Check/Live submission, collection and artifact handling, all plugin hooks, and the On/Live/Off commands. Chats and edits no longer capture or upload code. Existing credentials, settings and evidence are retained.

### Changed

- DeepScan is explicit: a file, folder or repository snapshot is submitted to `/deepscans`; the command polls until completion, saves evidence and returns findings. Use `/intent:deepscan collect [task-id]` to resume an interrupted DeepScan without resubmitting source. No hooks or detached workers run. Sign in with `intent-check login`. Prove remains a separate explicit workflow.

### Fixed

- Claude Code and Codex plugin installs use the last published release rather than unreleased branch contents. The release workflow advances the shared marketplace's tag and commit pin only after publication succeeds.

## [1.0.3] - 2026-11-02

### Added

- `intent-check view` serves a repository-aware live local viewer for saved evidence and active file checks. `--output` exports the same UI as a self-contained offline HTML report.
- DeepScan saves its final report and task/source metadata in `.intent/deepscan/<task-id>/`, with verified downloads, resumable collection and explicit expiry status. Saved reports remain available offline; supporting detail files stay on the service.

### Fixed

- Removed former product names from repository text and corrected outdated launcher and mode-control documentation.

## [1.0.2] - 2026-10-30

### Changed

- The CLI sends each run, validation and proof with an `Idempotency-Key` and retries it with the same key after a timeout, connection error or server error, so a retry never starts a second task. Proof and validation inputs are uploaded as one `specArchive` zip instead of one `specFile` field per file. This needs an Intent Check service with `Idempotency-Key` and `specArchive` support on these routes; an older service rejects the archive.

## [1.0.1] - 2026-10-26

### Changed

- The proof setup, dispatch and help skills are named `onboarding`, `using-prove` and `proof-help`. Setup messages, install instructions and proof guidance use Intent Check and prove mode naming.

### Fixed

- Codex guidance routes formal proofs through the global CLI. Sign-in guidance lets tasks continue while approval is pending, and doctor guidance no longer promises to start login.

## [1.0.0] - 2026-10-23

### Fixed

- The CLI accepts completed reused proof results with no tool runs, preserves the backend response and evidence, and still passes actual tool exit codes through unchanged.
- Release builds and CLI asset publication finish before the plugin branch advances to the new version.
- The plugin and global CLI use the same `config.toml` API and console endpoints, with the same environment overrides.

### Breaking

- The plugin now uses the Intent Check service API as its only backend. Reinstall or update the plugin, then use `onboarding` to install the global CLI.
- Report links from earlier versions stop working. Results open in the Intent Check console.
- Formal proofs are available through prove mode in this plugin (`/intent:prove`).
- Keys saved by earlier versions are not carried over.

### Added

- Prove mode: `/intent:prove [what to prove]` proves a program correct with K. Proof files go under `.intent/prove/<target>/`; the CLI's session state in `.intent/prove/sessions/` is not committed.
- The global `intent-check` command line tool. Each release includes it for macOS, Linux and Windows (x64 and arm64), with checksums and `install-intent-check.sh` / `install-intent-check.ps1`. Skills call it directly from `PATH`.
- `INTENT_CONSOLE_URL` sets the prover console that sign-in and result links open in.

### Changed

- Checks and DeepScans go to the prover API (`https://prover.intentcomputing.org`, `INTENT_API_URL` overrides it).
- Everything the plugin writes in your repo lives under `.intent/`. Proof sessions now detect the repository root automatically, so running from a subdirectory does not create a nested `.intent/`.

## [0.3.0] - 2026-10-13

### Changed

- `/intent:deepscan [files or a folder] [fast|balanced|full]` is the one command for a review on demand. Files get the fast review; a folder or nothing gets a DeepScan.

### Removed

- `/intent:check`: use `/intent:deepscan <files>`.
- `/intent:status` and `/intent:connect`: use `/intent:doctor`.
- `/intent:disconnect`: revoke a machine's key from your account page on the service.
- The `--depth` and `--scope` flags of `/intent:deepscan`: name the depth and the folder as plain arguments.

## [0.2.2] - 2026-10-09

### Changed

- The default service is https://check.intentcomputing.org.

### Fixed

- DeepScan leaves Intent Check's own `.intent/` results out of the snapshot.

## [0.2.1] - 2026-10-09

### Changed

- `fast` is the default DeepScan depth.

## [0.2.0] - 2026-10-09

### Added

- DeepScan: a scan of the whole repo, with a choice of depth (`fast`, `balanced`, `full`).

Earlier releases are listed at https://github.com/nlp-research-rosu/intent-check/releases.
