---
name: proving-spec
description: 'Use for formal proofs with K: construct K proofs or diagnose stuck, failing, or resource-limited Prover claims. Not for ordinary code review.'
---

## Artifact contract

This stage produces the proof-extension layer: additions to the
`VERIFICATION` module of `verification.k`, `prove.sh` with the exact
commands used, and a passing proof run.

`spec.k` is a set of K reachability claims. Prover attempts to prove each
claim by symbolically executing from the LHS and checking it reaches the RHS
under the given conditions. When a claim remains unproved, inspect the
residual configuration, a state it reached but could not close, in the saved
stdout. This skill provides the tools to read that residual and extend
`verification.k` until the proof closes.

Use `writing-spec` before this skill if `spec.k` is not yet written.

For EVM targets, read [EVM specification patterns](../shared/evm-spec-patterns.md)
before drafting or repairing the claims.

---

## Why proofs get stuck

The prover closes a claim by rewriting the LHS to the RHS. It gets stuck when:

- **Symbolic arithmetic does not reduce.** The backend cannot discharge the
  remaining obligation as written. Express the result through a summary whose
  defining equations or lemmas fit a theory the prover can use.
- **The loop-invariant circularity does not fire.** Its claim reuse attributes
  are missing, or the recurring symbolic configuration does not match the
  invariant claim's left-hand side closely enough to apply. See
  [circularity debugging](../shared/circularity-not-applying.md).
- **A helper rule is in the spec module instead of `verification.k`.** Plain
  `rule` statements in the spec module are a K compiler error; only `claim`s and
  `[simplification]` rules are allowed there.

Choose the diagnostic that fits the observed failure; the techniques below
are options, not a fixed sequence.

---

## Before adding a proof extension

Use the [soundness contract](../shared/proof-extension-soundness.md) to
classify and justify the extension. The
[Gate A obligations](../shared/gate-a-soundness.md) cover execution,
value, state, binding, and control fidelity. Record the applicable
justification and dependencies alongside the proof evidence.

Prefer strengthening an invariant, a truthful summary, or an auxiliary
execution claim when these address the residual. A genuine fixed-semantics
gap is a model boundary, not permission to replace program execution with
an unjustified result-bearing oracle.

## Gate A repair

Repair soundness findings under the
[shared repair contract](../shared/proof-extension-soundness.md#gate-a-repair-transition).
Preserve useful evidence, remove the unjustified dependency, and recheck
affected claims and obligations. A narrower theorem can be partial progress;
it does not complete a request for the full symbolic input domain.

---

## Summary functions

Summary definitions belong in `VERIFICATION-SUMMARIES`; proof extensions
belong in `VERIFICATION`. If a repair changes a definitional equation,
revisit the theorem's meaning and `SCOPE.md` using `writing-spec`, then
recheck affected claims and adequacy obligations. A separate spec audit
is optional; changed assumptions invalidate dependent evidence.

**Choose the simplest faithful form the prover can use.** Prefer an equivalent
closed form when it lies in a solver-supported theory. If no faithful closed
form exists, keep the recursive definition; do not replace it with an
inaccurate formula merely to make the proof close. Use explicit base/step
equations plus targeted induction, folding, or summary lemmas. A recursive
evaluator can still unfold indefinitely on a symbolic argument, so diagnose
that mechanism rather than rejecting recursion itself. See
[deriving-invariants.md](../shared/deriving-invariants.md) and
[symbolic-recursion debugging](../shared/symbolic-recursion.md).

**Add `[simplification]` lemmas** for algebraic facts the prover cannot derive
on its own. A `[simplification]` rule fires during symbolic simplification, not
during normal rewriting. Keep them in `verification.k` (or, if they apply only
to a specific proof, in the spec module):

```k
rule (X +Int Y) ==Int X +Int Z => Y ==Int Z  [simplification]
```

---

## Invariants and lemmas

The loop-invariant claim in `spec.k` is the loop invariant. When the proof is
stuck on the invariant's inductive step, common options include:

1. **Strengthen the invariant.** Add a conjunct to the `requires` or express a
   tighter postcondition.
2. **Add a lemma.** Add a `[simplification]` rule to `verification.k` that lets
   the prover discharge the residual algebraic obligation.

Keep the invariant and the summary function consistent: the invariant
postcondition (`s |-> S +Int sumTo(N)`) and the summary function definition
(`sumTo(N) = N*(N+1)/2`) must describe the same quantity.

---

## Proof construction and repair

**Submit and interpret evidence.** Use `intent-check prove --help` for
submission details and [running-k.md](../shared/running-k.md) for workflow and evidence
rules. Record the command in `prove.sh`.

An outcome of `proved` with tool exit 0 means the selected claims closed or
were admitted under the supplied theory; check the per-claim stdout and any
trusted labels under [reading the result](../shared/running-k.md#reading-the-result).
For `notProved`, read the stdout residual and stderr. Always submit under the
resource caps below.

**Read the residual.** The residual is the symbolic configuration
the prover reached but could not match against the claim's RHS. Extract it
from stdout as described in the shared result contract, then compare its term
shape to the RHS. The mismatch locates what is missing.

**Inspect a stalled trace when needed.** Isolating a claim and comparing
residual configurations at nearby depth bounds can reveal where progress
stops. Use the symptom router below to choose a focused diagnostic.

**Revise the proof strategy.** Choose a justified lemma, summary equation,
auxiliary claim, invariant strengthening, or different claim decomposition
that addresses the evidence. Recheck the affected claims.

Record the extension even when the proof passes; prover success does not
validate the added theory.

After editing `verification.k`, submit another attempt under the
[proof submission rules](../shared/running-k.md#proof-submission).

**Important hygiene:**

- Prefer proving dependencies first, such as inner-loop invariants before
  their callers. An unfiltered run alone does not make claims
  available to one another under APR; retain the reuse attributes from
  [writing-spec](../writing-spec/SKILL.md#claim-structure-and-reuse).
  Check the requested entry claims as well as their supporting claims.

---

## Proof progress

For server timeouts, HTTP request limits, and cancellation, follow
[kit-help](../kit-help/SKILL.md#task-timeouts).

`intent-check prove` polls Prover automatically and updates
`proof-NNN/result.json`. Keep the command running and read `metrics`
in that file to check progress when metrics are available. They may stay
unchanged while the backend is still working.

Check the saved result before retrying. If the proof keeps repeating
states or unfolding a helper, use the diagnostics below to find the cause.
Use `intent-check prove --help` for depth-bounded diagnostic options.

### Under a wall-clock limit

When the run itself has a deadline, a stuck task spends time you cannot
recover:

- Consider focused claims before the unfiltered run, so one stuck task costs
  one server execution limit, not the session.
- On every `proved`, copy the exact submitted `spec.k` and `verification.k`
  aside as the proved snapshot. Deliver files byte-identical to the latest
  snapshot. Make no edit after the last proved check; if an edit cannot be
  proved again before the deadline, restore the snapshot.
- If a cap suggests a mismatch between execution and the claim, concrete
  zero-, one-, and two-iteration cases can expose it cheaply. Use
  `intent-check run` and compare the final states with the claim; choose
  another diagnostic when the evidence points elsewhere.

---

## Symptom router and bounded inspection

Match the observed symptom, then open only the owning reference.

| Symptom | Open |
|---|---|
| Prover or the Kit client is unavailable | [running-k.md, Shell setup](../shared/running-k.md#shell-setup) |
| Backend or definition mismatch | [running-k.md, Backends](../shared/running-k.md#backends) |
| K cannot find the requested main syntax module | [running-k.md, Backends](../shared/running-k.md#backends) |
| Unsure whether a backend result means success | [running-k.md, Reading the result](../shared/running-k.md#reading-the-result) |
| Proof module rejects an ordinary rule | [k-claims.md, Functions and simplification](../shared/k-claims.md#functions-and-simplification) |
| `Unused filtering labels` | `intent-check prove --help` |
| A symbolic helper keeps expanding | [symbolic-recursion.md](../shared/symbolic-recursion.md) |
| A loop repeats and the invariant is never applied | [circularity-not-applying.md](../shared/circularity-not-applying.md) |
| An external operation has no faithful equations | [opaque-primitives.md](../shared/opaque-primitives.md) |
| Fixed rules stay stuck on a supersort variable while `isS(V)` holds | [sort-refinement.md](../shared/sort-refinement.md) |
| Stuck within the first few steps, e.g. on a plain variable lookup | [stuck-in-first-steps.md](../shared/stuck-in-first-steps.md) |
| A nested container claim stalls on constructor alternatives | [nested-sequences.md](../shared/nested-sequences.md) |
| The proof runs without revealing where progress stops | Bounded inspection below |

If a timed-out task leaves no residual, isolate one claim and inspect it with
a depth bound using `intent-check prove --help`, under the
[proof submission rules](../shared/running-k.md#proof-submission).

Choose the bound from the scale of the observed trace, not from a universal
fixed number. Compare the residual configuration at nearby increasing
bounds:

- New program points indicate continued symbolic progress.
- The same non-reducing subterm indicates a missing rule, undecidable
  guard, or helper that cannot simplify.
- Repeated loop-head shapes without claim application indicate a
  circularity matching problem.
- Rapidly growing helper terms indicate symbolic recursion.

A run with `--depth` is diagnostic, even if every claim closes within the
bound. Fix one identified mechanism, rebuild if needed, and rerun the isolated
claim without the bound for the final proof.

---

## References

- [Proof-extension soundness contract](../shared/proof-extension-soundness.md) , 
  construction-time classification and extension-record requirements.
- [K functions, claims, and proof modules](../shared/k-claims.md) , 
  `[function]`/`[simplification]`, claim syntax, and labels.
- [Running K through Prover](../shared/running-k.md), command discovery and
  evidence rules.
- `writing-spec`, states or revises `spec.k` and its scope.
- `validating-proof`, reviews passing evidence; it checks the
  extension inventory from the proof files rather than trusting the construction
  record, then applies Gate A, real-program soundness, Gate B, intent
  adequacy,
  and Gate C, trust and evidence auditability.

## Dispatch contract

- Inputs: the session ID; paths to `spec.k`,
  `verification.k`, `SCOPE.md`,
  and the task statement; on a redo, the failing audit artifact path.
- Produces: proof extensions in the `VERIFICATION` module, `prove.sh`
  with the exact commands used, and a passing proof run.
- Record: what closed, what theory was added, unresolved obligations, and
  artifact paths. Reuse this evidence in the final report or audit handoff.
