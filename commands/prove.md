---
description: Prove a program correct with K using the global intent-check CLI
argument-hint: "[what to prove]"
allowed-tools: Bash(intent-check:*)
---

The user wants a formal proof with K: $ARGUMENTS

Before remote execution, validation or proof submission, explain which selected program/specification/helper files will be uploaded to the configured Intent Check service. Stay within the requested scope.

Run `intent-check --version`. If the global CLI is missing or setup is incomplete,
follow the Intent Check skill's `references/onboarding.md` to install and connect it.

Then follow the Intent Check skill's `references/prove.md`. Proof artifacts go under the
automatically detected repository root's `.intent/prove/<target>/` directory.
