---
description: Prove a program correct with K using the global intent-check CLI
argument-hint: "[what to prove]"
allowed-tools: Bash(intent-check:*)
---

The user wants a formal proof with K: $ARGUMENTS

Use the matching global CLI release; check `intent-check requirements --help`
rather than relying on `--version` alone. If the CLI is missing, mismatched or setup
is incomplete, follow the `onboarding` skill for installation and connection guidance.

Then follow the `using-prove` skill. Proof artifacts go under the
automatically detected repository root's `.intent/logs/<run-uuid>/artifacts/` directory returned as `proofDir`; canonical results remain under that operation's root. Frozen inputs are in `evidenceDir/inputs/`. Read `.intent` directly with normal file tools; internal hook and worker entry points are reserved for the host.
