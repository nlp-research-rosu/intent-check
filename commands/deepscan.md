---
description: Review on demand with DeepScan (the whole repo, a folder, or files; runs in the background)
argument-hint: "[files or a folder] [fast|balanced|full]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/hooks.js":*)
---

The user wants a DeepScan: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/hooks.js" deepscan --data "${CLAUDE_PLUGIN_DATA}"` from the project root, adding what the user named:

- nothing: the whole repo is scanned.
- one folder: only that part of the repo is scanned.
- one or more files (at most 10): they get the fast review, which runs when this turn ends and takes a few minutes.
- `fast`, `balanced` or `full`: the depth of a whole-repo or folder scan (fast when they named none).

Then tell the user the command's answer in a line or two, with the report link if there is one. Do not wait or poll: a fast scan takes about 15-20 minutes, a balanced one 30-35 and a full one 40-45, and the result arrives as a note at a later message.
