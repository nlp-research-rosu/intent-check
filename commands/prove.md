---
description: Prove a program correct with K using the global intent-prover CLI
argument-hint: "[what to prove]"
allowed-tools: Bash(intent-prover:*)
---

The user wants a formal proof with K: $ARGUMENTS

Before remote execution, validation or proof submission, explain which selected program/specification/helper files will be uploaded to the configured Intent Prover service. Stay within the requested scope.

Follow the Intent Prover skill's `references/onboarding.md#check-cli-updates` once
for this requested workflow. If setup is incomplete, finish onboarding; reuse
saved sign-in.

Then follow the Intent Prover skill's `references/prove.md`. Proof artifacts go under the
automatically detected repository root's `.intent/prove/<target>/` directory.

Before handing off, update `PROOF.md` and `SCOPE.md` with the actual outcome,
claims, assumptions, assurance and remaining obligations. Follow the skill's
**Deliver results** section: run `intent-prover view --output <new-report.html>`,
verify the export and present one local HTML link opened at the target's Proof
report, with a brief outcome and limitations summary. Remote jobs are linked
inside the viewer; raw evidence and console links are secondary. Local viewing
requires neither network access nor login. Explain an export failure instead
of presenting a missing report; an HTML wrapper does not establish proof.
