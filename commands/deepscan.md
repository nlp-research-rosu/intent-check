---
description: Scan the whole repo with DeepScan (about 15 minutes, runs in the background)
argument-hint: "[--scope folder]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js":*)
---

The user wants a DeepScan of this repo: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" deepscan --data "${CLAUDE_PLUGIN_DATA}"` from the project root, adding `--scope <folder>` if the user named a folder.

Then tell the user the command's answer in a line or two, with the report link. Do not wait or poll: a scan takes about 15 minutes and the result arrives as a note at a later message.
