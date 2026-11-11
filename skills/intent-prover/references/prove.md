# Prove

A K proof connects a program's initial state to a required final state under
explicit assumptions. Write the claims and supporting mathematics; the Intent
Check service executes the pinned language semantics and attempts the proof.
Reachability claims establish partial correctness, not termination.

## Knowledge map

| Topic | Reference |
|---|---|
| Turning a requested property into claims | [Spec authoring](spec-authoring.md) |
| K notation and a spec-file example | [K glossary](k-glossary.md) |
| Syntax, sorts, modules and equations | [K syntax](k-syntax.md), [K claims](k-claims.md) |
| What makes a proof about the actual program | [Proof correctness](proof-correctness.md) |
| Loops, induction and summaries | [Invariants](deriving-invariants.md) |
| Stuck states, unapplied invariants and expanding helpers | [Proof debugging](proof-debugging.md) |
| Dynamic sorts, nested containers or external primitives | [Sort refinement](sort-refinement.md), [nested sequences](nested-sequences.md), [opaque primitives](opaque-primitives.md) |
| Ambiguous requirements | [Contract interpretation](reading-the-contract.md) |
| Sessions, input preparation, flags and results | [Running K](running-k.md) |
| Commands, connection, limits and task recovery | [CLI help](proof-help.md) |

## Working context

Use the global `intent-prover` CLI; [onboarding](onboarding.md) covers missing setup.
`semantics` lists supported definitions; `session start` pins and downloads one.
Construction and repairs share that session and its limits. Unsupported language
behavior is a model boundary, not a reason to author replacement semantics.

Artifacts live under `.intent/prove/<target>/` at the session's `projectRoot`:
`spec.k` states claims, `verification.k` supplies justified helpers, `SCOPE.md`
explains the theorem, `prove.sh` records commands, and `PROOF.md` records the
outcome and evidence. CLI-owned session files live in `.intent/prove/sessions/`.

Completion means the requested property is established for the agreed domain,
with matching program/claim bytes, terminal evidence and explicit assumptions.
Otherwise report the narrower result or unresolved obligation. Tool success
alone does not show that the claims describe the intended program behavior.
