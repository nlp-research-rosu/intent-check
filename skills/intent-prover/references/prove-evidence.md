# Prove: evidence and soundness

Check the actual frozen program, claims, imported helpers and submission controls
against the original task. A successful prover task closes claims under the supplied
theory; it does not validate that theory or establish the intended scope by itself.

## Read the result

Require `task.status: completed`, `task.result: proved` and no `task.error`. If tools
ran, require the final tool exit code 0. A reused result with `toolRuns: []` has no
new tool exit code. Inspect per-claim stdout, selected/excluded labels, trusted labels
and pending or failing leaves. Admitted claims are assumptions, not proved claims.
Validation success, process exit alone and aggregate results are insufficient.

Match frozen input hashes, actual program bodies, semantics ID/revision, controls
and assumptions to delivered files. Compare requirement content hashes independently
from source freshness; an ID alone cannot bind an edited record. Do not infer that
the brief was consumed or every associated requirement was established.

## A: real-program soundness

Rebuild the extension inventory from all actual proof-local modules, not just the
construction narrative. Classify each extension by its behavior:

| Class | Required justification |
|---|---|
| Definitional summary | Truthful, guarded, terminating mathematical equations covering every use |
| Derived lemma | Derivation over its complete guard from fixed semantics or established mathematics |
| Operational bridge | Universal equivalence to the fixed execution it replaces |
| Trusted primitive | Fixed external operation intentionally outside the theorem; explicit conditional contract |

Program-defined code must execute or have an exact auxiliary execution theorem;
it cannot become a trusted external primitive because proving it is hard. A rule
asserting the program result's desired property is the theorem assumed as an axiom,
not a derived lemma. Prove it as a claim/invariant without that rule.

Before admitting an operational bridge, require a machine-checked universal connection
theorem that does not import the bridge. Its justification must contain the bridge's
entire match domain: guards, binding, argument evaluation/order, continuations,
control stack, framed/omitted cells and state footprint. Preserve results, state,
resources, output, allocation and exceptions exposed by the model. A theorem for one
suffix does not justify an arbitrary continuation frame; value equality alone does
not justify return, cleanup, frame popping or other control effects. Priority supplies
no equivalence.

Trace every new opaque or summarized value through branches, results, state and
exceptions. A program-derived value needs an exact fixed-semantics value connection,
not the same fresh oracle appearing in both execution and postcondition. A fixed,
intentionally external primitive may remain interpretation-parametric, or every
value-level conclusion must be conditional on its named contract.

Check equation truth over all guards, coverage, recursive descent, totalization and
pairwise overlap: overlapping equations must agree. “The bad case is unreachable”
does not justify a globally false rule. Establish a realizable precondition and a
non-vacuous constraint on the relevant result/state, with required claims exercised.

When uncertainty warrants it, use fixed-versus-extended witnesses or body/continuation
mutations to test execution fidelity, and false-postcondition mutations to test result
constraint. They answer different questions. A negative control requires `notProved`
and a reachable unmet-condition witness; parser errors/timeouts do not count.
Finite tests never replace a required universal connection theorem.

## B: adequacy to intent

Compare the proved domain and summaries with the full requested contract, including
types, edge classes and observed cells. Candidate-added bounds, stronger guards,
missing constructors or unfinished branches remain narrowing. A theorem describing
an implementation that conflicts with its requirements is a discrepancy, not a proof
that the requirements hold.

A genuine fixed-model boundary must be witnessed, not guessed: retain an execution
the model cannot complete or a missing-constructor witness. If the model represents
the class, cover it. Check material differences in numbers, text, collections,
external state, exceptions and concurrency; do not assert edge-value fidelity without
checked evidence on both models. Prove the full contract over representable values
and state the conditional model boundary explicitly. An intentionally opaque supplied
primitive is a trust boundary, not candidate domain narrowing. A contract-inherent
undefined computation may be excluded only with the exclusion explicit and the same
behavior in the program, not a substituted answer.

## C: trust and auditability

For every extension, record its exact symbol/rule, class, full guard/matched context,
justification scope and containment, state footprint, value/control influence and
dependent claims. For each unproved component, state the named assumption, why it
is outside the theorem and supporting evidence. Keep the inventory in `PROOF.md`.

For claimed concrete/differential/mutation checks, retain the artifact, exact command,
inputs, independent oracle and actual result. Differential oracles must not merely
reuse proof equations; record mismatches rather than claiming empirical support.
Distinguish proved facts, conditional conclusions, finite evidence and excluded behavior.

## Repair and report

An unjustified A obligation is incomplete work, not a successful proof. Remove the
dependency, repair using fixed semantics and justified theory, then recheck affected
claims within the existing budget. Hard proof work or a slower safe encoding is not
a blocker. A tooling failure is blocked evidence collection, not proof of unsoundness.
Call an extension unsound only with a concrete or symbolic false-conclusion witness;
otherwise identify the precise missing justification, which still cannot receive PASS.

| Completed assessment | Status |
|---|---|
| A fails or is unresolved when work stops | Incomplete work |
| A passes, B fails | SOUND-BUT-LIMITED |
| A and B pass, C fails | FORMALLY-SOUND-UNVALIDATED |
| A, B and C pass | VALIDATED |

Identify unchecked/blocked obligations and later-gate failures explicitly. In `PROOF.md`,
give the status, established scope/claims, extensions, exact commands and actual results,
gate findings, trust boundary, finite evidence, exclusions and remaining work.
`VALIDATED` does not imply independent review or replay. State the review mode,
evidence reused and important checks performed or omitted.

Reuse evidence when program, claims, helpers, semantics, controls and assumptions
match. Review commands without executing them merely to audit. Replay only for a
user request, changed inputs or a specific unresolved reproducibility question; scope
it to affected claims/dependencies and retain original/new task IDs. An independent
review is optional and needs a permitted separate context; keep the candidate unchanged
during an audit. Do not start another proof run merely because a reviewer changed.
