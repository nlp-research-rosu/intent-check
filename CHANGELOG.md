# Changelog

What changed for people who use the plugin, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is 0.x, a minor bump (0.2 to 0.3) can remove or rename commands.

Maintainers: add a line under Unreleased in the same pull request as the change. The release workflow gives that section the version number and uses it as the release notes.

## [Unreleased]

### Breaking

- The plugin now uses the prover API as its only backend. Reinstall or update the plugin and sign in once: the first prompt shows a link to the prover console.
- Report links from earlier versions stop working. Results open in the prover console.
- The KIT plugin is replaced by prove mode in this plugin (`/intent:prove`). Uninstall KIT.
- `.prover-client/` and `~/.config/prover-client` are no longer used. Keys saved by earlier versions are not carried over.
- The plugin's script is `bin/hooks.js` (was `bin/intent.js`). This matters only if you call it by path on Codex.

### Added

- Prove mode: `/intent:prove [what to prove]` proves a program correct with K. Proof files go under `.intent/prove/<target>/`; the CLI's session state in `.intent/prove/sessions/` is not committed.
- The `intent-check` command line tool. The first `/intent:prove` downloads it for the plugin version, and each release includes it for macOS, Linux and Windows (x64 and arm64), with checksums and `install-intent-check.sh` / `install-intent-check.ps1` for installing it on its own.
- `INTENT_CONSOLE_URL` sets the prover console that sign-in and result links open in. `INTENT_CLI_PATH` points the plugin at a local `intent-check` binary (development).

### Changed

- Sign-in runs through the prover console, and the key is saved in `~/.config/intent-check/credentials.json`, shared with the `intent-check` command. For cloud sessions and CI, set `INTENT_API_KEY`.
- Checks and DeepScans go to the prover API (`https://prover.intentcomputing.org`, `INTENT_API_URL` overrides it).
- Everything the plugin writes in your repo lives under `.intent/`.
- The README describes all four modes (check, live, deepscan, prove), sign-in, the commands, file locations and environment variables, and no longer lists sample report pages.

## [0.3.0] - 2026-10-13

### Changed

- Five commands replace eight. `/intent:on` turns checks on (your changes are reviewed at the end of each turn), `/intent:live` turns them on in live mode (every edit is also reviewed as it happens), and `/intent:off` turns them off. `/intent:on` turns live mode off again.
- `/intent:deepscan [files or a folder] [fast|balanced|full]` is the one command for a review on demand. Files get the fast review; a folder or nothing gets a DeepScan.
- `/intent:doctor` shows the plugin's state and repairs what it can: it gives a fresh connect link when the account is not connected, replaces a saved key the service no longer accepts, and updates the plugin on Claude Code. Its first line names a newer release when there is one.
- `INTENT_LIVE=1` or `0` sets live mode from the environment.

### Fixed

- Windows: a state file another hook has just released no longer fails the check, repository paths from git match the rest of the plugin's paths, and the shadow snapshot runs without the user's git config there too.

### Removed

- `/intent:check`: use `/intent:deepscan <files>`.
- `/intent:mode`: use `/intent:on` or `/intent:live`.
- `/intent:status` and `/intent:connect`: use `/intent:doctor`.
- `/intent:disconnect`: revoke a machine's key from your account page on the service.
- The `--depth` and `--scope` flags of `/intent:deepscan`: name the depth and the folder as plain arguments.
- Settings saved by early versions are no longer read: the top-level `api_key` (the next prompt shows a connect link), `mode` and `per_edit` (run `/intent:live` again), and the `INTENT_MODE` variable (use `INTENT_LIVE`).

## [0.2.4] - 2026-10-13

### Added

- When the service cannot finish a check, you now get one line saying so instead of silence.

### Fixed

- Text that the host adds to a prompt (reminders, task notifications) is no longer sent as if you had typed it.
- A "done" or "skip" reply to the connect link is recognised when the host has added text in front of it.

## [0.2.3] - 2026-10-10

### Added

- Small HTML apps with real logic are checked, not skipped as markup.
- In per-edit mode, files written by shell commands are caught without a git repository, and PowerShell commands are handled.

### Fixed

- Each turn is judged against its own prompts, not those of a later turn.
- The agent carries on with your request when the connection was approved before you replied "done".

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
- Per-edit checking becomes a mode of the main plugin, on Claude Code and Codex.

Earlier releases are listed at https://github.com/nlp-research-rosu/intent-check/releases.
