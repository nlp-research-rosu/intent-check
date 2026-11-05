---
description: Scan code remotely and wait for results, or resume an interrupted Scan
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
- `collect [task-id]`: resume waiting and save results, without submitting code. Without an ID, collect outstanding scans in this project.

The command prints a task/report link, polls the service until the task finishes, saves the evidence and returns findings. Keep the command running; use the host's long-running command support rather than starting another Scan. Show the final result and report link. No hooks or detached workers run.

If the command is interrupted or polling fails, the remote task may continue. Resume with `collect <task-id>`; do not resubmit code or implement an agent-side polling loop.
