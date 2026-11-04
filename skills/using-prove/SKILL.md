---
name: using-prove
description: 'Use for formal proofs with K: verify a program with K and the Intent Check service, or choose the relevant proof skill. Not for ordinary code review (the intent-check skill owns that).'
---

## What prove mode establishes

Prove mode establishes **partial correctness**: if a program terminates and its
precondition holds, its postcondition holds at termination. Termination
requires a separate argument.

Establish the requested property over the agreed scope using the selected
semantics. Choose a proof strategy suited to the target, inspect the
resulting evidence, and address gaps within the available budget. Report
what is proved, what depends on assumptions, and what remains unresolved.

## Where files go

Prepare inputs in the session's returned `workspaceDir/inputs/` (ignored authoring scratch).
Each prove submission freezes its exact uploaded inputs in the repository-root
`.intent/logs/<run-id>/inputs/`. Use the returned `proofDir` (the operation's
`artifacts/`) for `SCOPE.md`, `prove.sh` and `PROOF.md`. Canonical request/result/log/metrics
evidence lives in the returned `evidenceDir`, under `.intent/logs/<run-id>/`.
Current formal files live under per-source `specs/<spec-id>/`, selected by `index.json`.
Use `--spec-id <id>` to update or intentionally share an existing bundle;
omit it to create an independent bundle, even when filenames match.
Use `--target <source-path>[::symbol]` for declared source coverage and
`--requirement <id>` for an existing CLI-assigned structured requirement when applicable.
These associations are declarations, not automatic proof of those requirements.
Uploaded dependencies and trusted claims are not additional verified targets.
The CLI detects `projectRoot` automatically. Scratch `.intent/prove/sessions/`
and machine session bookkeeping are not durable proof evidence.

### Bind local requirements

For a new structured requirement, save this transport input outside `.intent/`
as `requirement-input.json`:

```json
{
  "statement": "Reject negative input prices.",
  "targets": [{"path": "src/pricing.py", "symbol": "calculate_total"}],
  "reason": "Negative prices are invalid."
}
```

```sh
intent-check requirements add --input requirement-input.json
intent-check requirements show <id>
# If the statement or targets change, edit the input and retain the ID:
intent-check requirements update <id> --input requirement-input.json
```

The CLI assigns six-character lowercase letter/digit IDs and derives placement: one exact source file (even multiple
methods) uses `.intent/source/<source-path>/requirements.json`; multiple source
files use `.intent/source/requirements.json`. Update relocates the same ID without a
duplicate. Add/update have no `--file` flag and `--input` is not a store destination.
Documents contain only `schema_version: 1` and `requirements`; records contain
`id`, `statement`, nonempty `targets`, and optional `reason`. Target `path` is
required; optional `symbol` is a function/method qualified name, not a variable.
No kind, provenance, assumptions or references fields are accepted.
The project-wide editable brief starts with `# Project requirements` and five
empty sections: Purpose, Expected behavior, Constraints, Out of scope and
Open questions. It is not synchronized with JSON. See
[local requirements](../proof-help/SKILL.md#local-requirements) for management details.

Use the returned ID, not an invented ID, with `--requirement`. Proof request
manifests bind the record's exact content hash but do not upload its prose or
certify it. Edited/deleted records are stale independently of unchanged source.
Trusted claims remain assumptions; aggregate server results do not establish
per-claim coverage or an independent audit.

## Start live verification

Live verification is the default. Use the global `intent-check` CLI on `PATH`.
See [running-k.md](../shared/running-k.md#shell-setup).
Use [onboarding](../onboarding/SKILL.md) when setup or authentication
is incomplete (sign in with `intent-check login`); use command help for
invocation details.

Discover available semantics with `intent-check semantics`, select an ID
matching the target, and inspect its pinned sources and backend capabilities.
Start one bounded session before construction and reuse its
session ID for concrete runs, validation, proofs, and repairs. Follow the
[semantics selection contract](../shared/running-k.md#semantics-descriptor).
Live prove mode uses bundled semantics, not user-authored semantics files. If no
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
follow [proof-help](../proof-help/SKILL.md#attempt-limits); do not start another
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

If the Intent Check service remains unavailable, stop as BLOCKED and report the exact
error and unresolved obligations. Do not claim a successful proof.

## Find the relevant guidance

| Need | Open |
|---|---|
| Install or connect Intent Check | [onboarding](../onboarding/SKILL.md) |
| CLI usage, settings, or resource limits | [proof-help](../proof-help/SKILL.md) |
| State a theorem or revise its scope | [writing-spec](../writing-spec/SKILL.md) |
| Review claim adequacy or summary meaning | [auditing-spec](../auditing-spec/SKILL.md) |
| Construct a proof or diagnose a stuck claim | [proving-spec](../proving-spec/SKILL.md) |
| Review proof soundness and evidence | [validating-proof](../validating-proof/SKILL.md) |
| Derive an invariant | [deriving-invariants.md](../shared/deriving-invariants.md) |
| Interpret a natural-language contract | [reading-the-contract.md](../shared/reading-the-contract.md) |
| K syntax, claims, or live commands | [k-syntax.md](../shared/k-syntax.md), [k-claims.md](../shared/k-claims.md), [running-k.md](../shared/running-k.md) |
| Prepare or audit semantics for a future Intent Check service release | [writing-semantics](../writing-semantics/SKILL.md), [auditing-semantics](../auditing-semantics/SKILL.md) |
