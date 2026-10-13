---
description: Turn Intent Check on in live mode (also checks every edit as it happens)
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/intent.js" live --data "${CLAUDE_PLUGIN_DATA}"`

Tell the user the lines above, word for word, and nothing else.
