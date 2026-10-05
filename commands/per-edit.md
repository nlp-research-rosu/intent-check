---
description: Turn per-edit checks on or off (on checks every edit as it happens)
argument-hint: "on | off"
allowed-tools: Bash(sh ${CLAUDE_PLUGIN_ROOT}/bin/intent:*)
---

!`sh "${CLAUDE_PLUGIN_ROOT}/bin/intent" per-edit $ARGUMENTS --data "${CLAUDE_PLUGIN_DATA}"`

Tell the user the line above, word for word, and nothing else.
