---
description: Show or set the Intent Check mode (classic checks each turn; per-edit checks every edit as it happens)
argument-hint: "classic | per-edit"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" mode $ARGUMENTS --data "${CLAUDE_PLUGIN_DATA}"`

Tell the user the line above, word for word, and nothing else.
