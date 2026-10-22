---
description: Prove a program correct with K (gets the intent-check CLI first)
argument-hint: "[what to prove]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/hooks.js":*)
---

The user wants a formal proof with K: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/hooks.js" prove --data "${CLAUDE_PLUGIN_DATA}"`. It downloads the `intent-check` CLI for this plugin version if it is missing and prints its absolute path.

Then follow the `using-kit` skill, using that path wherever the skills say `intent-check`. If the command fails, tell the user what it printed and stop.
