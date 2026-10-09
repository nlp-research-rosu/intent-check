---
description: Scan the whole repo with DeepScan (fast, balanced or full; runs in the background)
argument-hint: "[fast|balanced|full] [--scope folder]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js":*)
---

The user wants a DeepScan of this repo: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" deepscan --data "${CLAUDE_PLUGIN_DATA}"` from the project root, adding `--depth <depth>` if the user named one of fast, balanced or full (fast when they named none), and `--scope <folder>` if they named a folder.

Then tell the user the command's answer in a line or two, with the report link. Do not wait or poll: a fast scan takes about 15-20 minutes, a balanced one 30-35 and a full one 40-45, and the result arrives as a note at a later message.
