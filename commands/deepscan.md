---
description: Explicitly scan code remotely, or collect an existing Scan result
argument-hint: "[files or a folder] [fast|balanced|full] | collect [task-id]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js":*)
---

The user requested: $ARGUMENTS

For a new Scan, tell the user before running it that the named files (or a repository/folder snapshot) will be uploaded to the configured Intent Check service, with obvious secrets masked. File scans also include prior file evidence and `.intent/NOTES.md` when present. No chat transcript is uploaded. Do not widen the requested scope.

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" deepscan --data "${CLAUDE_PLUGIN_DATA}"` from the project, adding the arguments:

- No path: scan the whole repository.
- One folder: scan only that folder.
- Files (at most 10): submit a fast file review immediately.
- `fast`, `balanced` or `full`: repository/folder depth; default `fast`.
- `collect [task-id]`: fetch status and save finished results, without submitting code. Without an ID, collect outstanding scans in this project.

Show the result and report link. No hooks, background workers or automatic result delivery run. To fetch a result later, invoke the same command with `collect <task-id>`; do not poll in a loop or resubmit to check progress.
