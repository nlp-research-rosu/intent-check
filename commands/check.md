---
description: Queue an Intent Check review of files (runs in the background after this turn)
argument-hint: "[paths | --repo]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/intent.js:*)
---

The user wants these reviewed by Intent Check: $ARGUMENTS

- If paths were given, run `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" check --data "${CLAUDE_PLUGIN_DATA}" <paths>` with them.
- If they asked for the whole repo, or `--repo` was given, pick up to 10 of the most relevant source files (entry points, auth, payments, data handling, core logic; not tests, UI, config or generated code) and run `node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" check --data "${CLAUDE_PLUGIN_DATA}" --repo <paths>`.
- If nothing was given, use the source files changed in this session.

Then tell the user the command's one-line answer. Do not wait for the result; it arrives as a note after this turn.
