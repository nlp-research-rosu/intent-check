---
name: using-kit
description: 'Use for formal proofs with K: verify a program with K and Prover, or choose the relevant proof skill. Not for ordinary code review (the intent-check skill owns that).'
---

## What this kit proves

KIT proves **partial correctness**: if a program terminates and its
precondition holds, its postcondition holds at termination. Termination
requires a separate argument.

Establish the requested property over the agreed scope using the selected
semantics. Choose a proof strategy suited to the target, inspect the
resulting evidence, and address gaps within the available budget. Report
what is proved, what depends on assumptions, and what remains unresolved.

## Where files go

Everything you write for a proof lives in `.intent/prove/<target>/`, one folder
per program or function being proved. Pick a short kebab-case name, for example
`.intent/prove/should-strip-auth/`. Put `spec.k`, `verification.k`, `SCOPE.md`,
`prove.sh`, `PROOF.md`, the program copy and any differential test there. These
files are meant to be committed; the CLI's session state in
`.intent/prove/sessions/` is not.

## Start live verification

Live verification is the default. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/hooks.js" prove --data "${CLAUDE_PLUGIN_DATA}"` first (if you cannot, ask the user to run
`/intent:prove`): it prints the absolute path of the
`intent-check` CLI, which stands for `intent-check` in every command below.
See [running-k.md](../shared/running-k.md#shell-setup).
Use [kit-onboarding](../kit-onboarding/SKILL.md) when setup or authentication
is incomplete; use command help for invocation details.

Discover available semantics with `intent-check semantics`, select an ID
matching the target, and inspect its pinned sources and backend capabilities.
Start one bounded session before construction and reuse its
session ID for concrete runs, validation, proofs, and repairs. Follow the
[semantics selection contract](../shared/running-k.md#semantics-descriptor).
Live KIT uses bundled semantics, not user-authored semantics files. If no
supported ID matches, report the model gap rather than inventing a live
semantics or silently narrowing the target.

## Choose the work that advances the target

Load specialist skills and references as needed; they are not mandatory
stages. Specification, construction, and review can be interleaved. Keep
the scope and proof artifacts current as the approach changes.

Prefer bottom-up verification: start with the leaf dependencies needed by
the requested target, then build toward higher-level components and their
interactions. Dependency order matters more than function size. The target
may be a function, smart contract, program, or whole codebase.

Reuse helper claims only with the dependency and scope connections described
in [writing-spec](../writing-spec/SKILL.md#claim-structure-and-reuse).
Track remaining obligations in `SCOPE.md`; proving helpers or isolated
function bodies does not establish their callers or the complete target.

Continue through proof construction, evidence review, and repairs until the
requested scope is established or a concrete blocker or resource limit
prevents further work. Ask only when an unresolved scope, resource, or
authorization decision materially affects the work. For attempt limits,
follow [kit-help](../kit-help/SKILL.md#attempt-limits); do not start another
session to bypass an exhausted budget. Approval to raise a limit resumes
the existing session. Other new user feedback that re-enters verification
starts a fresh session; explanation-only questions create none.

## Review evidence and report

Same-agent evidence review is the default. Use
[validating-proof](../validating-proof/SKILL.md) to check the actual proof
artifacts and results against the original task, not just the construction
narrative. The [soundness contract](../shared/proof-extension-soundness.md)
owns the correctness requirements and status meanings. Its gates cover
[soundness](../shared/gate-a-soundness.md),
[adequacy](../shared/gate-b-adequacy.md), and
[evidence](../shared/gate-c-evidence.md).

Request an independent audit when the user asks for it or the uncertainty
warrants a separate reviewer and the harness permits delegation. Give that
reviewer the original task and frozen artifact paths, without inherited
construction reasoning. Record `same-agent review` or `independent review`
accurately. Independent review and replay are distinct assurance measures.

Follow [review assurance](../shared/proof-extension-soundness.md#review-assurance)
for evidence reuse, scoped replay, and recording the checks performed or
omitted. A separate audit report is useful for a requested audit or handoff;
ordinary review can be recorded directly in `PROOF.md` without duplicate stage
reports.

Deliver the exact proved artifacts, `SCOPE.md`, reproducible commands in
`prove.sh`, and `PROOF.md` with the status, session IDs, evidence paths,
assumptions, and remaining obligations. Claim completion only for the
requested scope actually established. A narrower proof is partial progress.

## When live verification is unavailable

If Prover remains unavailable, stop as BLOCKED and report the exact
error and unresolved obligations. Do not claim a successful proof.

## Find the relevant guidance

| Need | Open |
|---|---|
| Install or connect KIT | [kit-onboarding](../kit-onboarding/SKILL.md) |
| CLI usage, settings, or resource limits | [kit-help](../kit-help/SKILL.md) |
| State a theorem or revise its scope | [writing-spec](../writing-spec/SKILL.md) |
| Review claim adequacy or summary meaning | [auditing-spec](../auditing-spec/SKILL.md) |
| Construct a proof or diagnose a stuck claim | [proving-spec](../proving-spec/SKILL.md) |
| Review proof soundness and evidence | [validating-proof](../validating-proof/SKILL.md) |
| Derive an invariant | [deriving-invariants.md](../shared/deriving-invariants.md) |
| Interpret a natural-language contract | [reading-the-contract.md](../shared/reading-the-contract.md) |
| K syntax, claims, or live commands | [k-syntax.md](../shared/k-syntax.md), [k-claims.md](../shared/k-claims.md), [running-k.md](../shared/running-k.md) |
| Prepare or audit semantics for a future Prover release | [writing-semantics](../writing-semantics/SKILL.md), [auditing-semantics](../auditing-semantics/SKILL.md) |
