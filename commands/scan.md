---
description: Run Scan remotely and wait for results, or resume an interrupted Scan
argument-hint: "[file or folder] [fast|balanced|full] | collect [task-id]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js":*)
---

The user requested: $ARGUMENTS

First follow the Intent Check skill's `references/onboarding.md#check-cli-updates`.
Reuse saved sign-in; check once for this requested workflow, not on each poll.

For a new Scan, tell the user before running it that a snapshot of the selected file, folder or repository will be uploaded to the configured Intent Check service, with obvious secrets masked. Project notes in `.intent/NOTES.md` are included when they fall within the selected scope; other `.intent/` evidence and chat transcripts are not uploaded. Do not widen the requested scope.

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" scan --data "${CLAUDE_PLUGIN_DATA}"` from the project, adding the arguments:

- No path: scan the whole repository.
- One file or folder: limit Scan to that path. Run from inside a Git repository.
- `fast`, `balanced` or `full`: Scan depth; default `fast`.
- `collect [task-id]`: resume waiting and save results, without submitting code. Without an ID, collect outstanding scans in this project.

The command prints a task/report link, polls the service until the task finishes, saves the evidence and returns findings. Keep the command running; use the host's long-running command support rather than starting another Scan. Show the final result and report link. No hooks or detached workers run.

If the command is interrupted or polling fails, the remote task may continue. Resume with `collect <task-id>`; do not resubmit code or implement an agent-side polling loop.
