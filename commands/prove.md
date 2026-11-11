---
description: Prove a program correct with K using the global intent-prover CLI
argument-hint: "[what to prove]"
allowed-tools: Bash(intent-prover:*)
---

The user wants a formal proof with K: $ARGUMENTS

Before remote execution, validation or proof submission, explain which selected program/specification/helper files will be uploaded to the configured Intent Prover service. Stay within the requested scope.

Run `intent-prover --version`. If the global CLI is missing or setup is incomplete,
follow the Intent Prover skill's `references/onboarding.md` to install and connect it.

Then follow the Intent Prover skill's `references/prove.md`. Proof artifacts go under the
automatically detected repository root's `.intent/prove/<target>/` directory.
