---
name: writing-spec
description: 'Use for formal proofs with K: draft or revise K reachability claims, summaries, and verification scope for a program. Not for ordinary code review.'
---

## Artifact contract

This stage states the theorem. It produces three artifacts: `spec.k`
(the reachability claims), the `VERIFICATION-SUMMARIES` module of
`verification.k` (the summary definitions the claims reference), and
`SCOPE.md` (the scope record the spec audit reads).

`spec.k` and `verification.k` compile against the immutable semantics selected
by the session ID. Inspect it with `intent-check session show` first:

| State | Action |
|---|---|
| ID appears in the Prover registry and the target program runs | Proceed |
| ID appears, but the target program gets stuck | Record the model boundary |
| ID is absent | Stop as BLOCKED; do not author semantics inside live Kit |

Also confirm that concrete program identifiers used by the claims parse as
identifiers rather than K rule variables. See
[K syntax and operational semantics](../shared/k-syntax.md#grammar).

For EVM targets, read [EVM specification patterns](../shared/evm-spec-patterns.md)
before drafting or repairing the claims.

---

## What a spec is

A K spec states **partial correctness**: *if* the program terminates and the
precondition holds, then the postcondition holds at termination. It says nothing
about whether the program terminates; that is a separate liveness question.

Keep three activities distinct: **Verification** closes
reachability claims under the supplied theory; **Soundness audit** checks proof
extensions; and **Validation** checks theorem scope and evidence against the
intended property.

---

## Record the scope in SCOPE.md

Keep `SCOPE.md` beside `spec.k` as the durable record of the target and
the submitted claims. An unstated reading or silently omitted observable
cell is a scope gap, not a stylistic choice.

### Plain-language opening

Make `## Property in plain language` the first section after the title,
before technical scope details. Before submitting a K specification to the
prover, describe each property checked in this section so the reader can
understand it without reading the formal spec.

Use ASD-STE100 writing principles: short sentences, direct statements,
consistent terms, and simple words. Do not use K notation or undefined
technical terms. Explain the permitted inputs, required result and state
changes, and important conditions or exclusions. Describe the submitted
claims, not a stronger intended property. State that termination is not
proved when the claims establish only partial correctness. Update the
description whenever claims or summary definitions change.

For example, the opening for a summation property could be:

```markdown
# Verification scope

## Property in plain language

The input is a whole number that is zero or greater.
The program adds all numbers from 1 through the input number.
If the program finishes, it stores this sum.
This check does not prove that the program will finish.

## Program boundary

[Continue with the technical scope details.]
```

### Technical scope

After the opening, record five items:

| Item | Record |
|---|---|
| Program boundary | Exact entry computation and program-defined operations included in the theorem |
| Input domain | Types, guards, well-formedness conditions, and excluded inputs |
| Observable final state | Result and every state cell the intended property observes |
| Intended property | Plain-language result expected after termination |
| Chosen contract readings | Each underdetermined point, the reading chosen, and why |

The spec may frame cells that are intentionally irrelevant, but the scope record
must say why they are unobserved. Do not silently omit a cell whose change is
part of the intended behavior.

When the task requires the full source contract, the required entry claim or
claims must collectively cover that contract's input domain. Do not replace an
unbounded or symbolic domain with finitely many concrete sizes, examples, or
bounded unrollings. Such claims may be kept as diagnostic progress, but they are
not the required target theorem unless the source contract states the same
bound.

## Reading the contract

When the property arrives as a docstring-style natural-language
contract, resolve its stated meaning and its silences with
[reading-the-contract.md](../shared/reading-the-contract.md), and
record every chosen reading in `SCOPE.md`.

---

## Pre- and postconditions

Conditions are constraints on cell contents, written as `requires` and `ensures`
clauses on a `claim`:

- **`requires`**, the precondition: a Boolean expression over the LHS cell
  values. The claim is only attempted when this holds.
- **`ensures`**, the postcondition: a Boolean expression over the RHS cell
  values. May introduce existential variables written `?X` (e.g. `ensures ?R
  ==Int sumTo(N0)`). Any RHS variable not bound on the LHS must use `?`;
  omitting it is a hard K error.

Preconditions and postconditions are constraints on the full K configuration
(the `<k>` cell and every state cell) before and after the rewrite, not just
function inputs/outputs in the ordinary sense.

**Read each operator from the semantics, not from its symbol.** A language
may give `+`, `<` or `==` a meaning other than the familiar one. Find the rule
for operators whose meaning affects the property. Where the behavior is
uncertain, a small `intent-check run` or a one-step claim can confirm the
reading. Record consequential model assumptions in `SCOPE.md`.

**Keep `requires` to the contract's input domain.** Never add a conjunct to
avoid non-termination or to make a loop run zero times; the
[input-domain obligations](../shared/gate-b-adequacy.md#b1-input-domain-alignment)
say how to split the domain instead and when an exclusion is justified.
A precondition under which a loop cannot run even once is a sign of a
misread operator: re-read the operator rules before keeping it.

**Programs that produce a return value**, use `ensures` to constrain it.
Example shape for a claim where the computation leaves a result `?R` in `<k>`:

```k
claim [my-prog]:
      <k> myProgram(N0:Int) => ?R:Int </k>
      <state> S </state>
  requires N0 >=Int 0
  ensures  ?R ==Int sumTo(N0)
```

**Programs that terminate with a state** (no return value), express the
postcondition as the RHS of the state cells directly, without `ensures`:

```k
<state> .Map => n |-> 0 s |-> sumTo(N0) </state>
```

---

## Claim structure and reuse

Choose claims that cover the requested entry behavior and its proof
obligations. A common decomposition is an entry claim plus invariant claims
for loops; nested loops can use inner invariants from the outer proof.
Multiple entries, helper claims, or another decomposition may fit better.
The single-loop example below illustrates two claims, not a fixed count.

Give every claim a stable label (`claim [name]:`). PyK APR uses a claim as its
own circularity only when it has `[circularity]`; a claim uses another claim
only when it names that label in `[depends(...)]`. The entry claim depends on
its loop invariant. An outer loop invariant that uses an inner one needs both
attributes.

A claim selected with `--trusted` is not proved. Name it in each caller's
`[depends(...)]` list and record it as an assumption under the
[soundness contract](../shared/proof-extension-soundness.md). The prover does
not infer a dependency from an earlier proof run; see
[proof submission](../shared/running-k.md#proof-submission). Never restate a
proven claim as an installed rewrite rule to make it available: an ordinary
rule stands outside the proof and may assume the conclusion.

### 1. Entry (whole-program) claim

States what the full program does from its initial configuration to termination.

```k
claim [sum-prog]:
      <k> n = N0:Int ; s = 0 ;
          while (n > 0) { s = s + n ; n = n - 1 ; } => .K ...</k>
      <state> .Map => n |-> 0 s |-> sumTo(N0) </state>
  requires N0 >=Int 0
  [depends(loop-inv)]
```

- LHS: the full program text in `<k>`; initial state (`.Map` = empty).
- RHS: `.K` in `<k>` means all computation is done; the final state maps are the
  postcondition.
- `...` in `<k>` is a frame variable for the rest of the continuation.
- The state uses a closed map (no `...`) when exactly those keys must be
  present.
- Every value on the right-hand side is part of the theorem. `n |-> 0` is
  true here because this loop counts `n` down to zero. For a variable that is
  not an output and whose exit value you have not worked out, write `?_`.
- Constrain results through right-hand-side values or `?X` variables, never
  through a variable bound on the left of a cell the program overwrites: an
  `ensures` on that initial symbol restricts the input, not the result.

### 2. Loop-invariant (circularity) claim

States what the loop does at the loop head, given symbolic accumulator values.
This is the coinductive hypothesis: APR applies the circularity claim at a
matching loop head to discharge the loop.

```k
claim [loop-inv]:
      <k> while (n > 0) { s = s + n ; n = n - 1 ; } => .K ...</k>
      <state> n |-> (N:Int => 0)
              s |-> (S:Int => S +Int sumTo(N)) </state>
  requires N >=Int 0
  [circularity]
```

- Starting at the loop head with `n |-> N` and `s |-> S` (both symbolic), `N >=
  0`.
- The loop terminates with `n |-> 0` and `s |-> S + sumTo(N)`.
- The `=>` inside each cell maps old to new: `N:Int => 0` means `n` starts at
  `N` and ends at `0`. It asserts that exit value; do not copy the shape for a
  variable that ends elsewhere.

Both claims live in a single spec module that only contains `claim`s (and
optionally `[simplification]` rules). Plain `rule` statements in a spec module
are a K compiler error.

```k
requires "verification.k"

module SPEC
  imports VERIFICATION

  claim [loop-inv]: ... [circularity]
  claim [sum-prog]: ... [depends(loop-inv)]
endmodule
```

---

## The loop invariant and its summary

The loop invariant ties the running accumulator to the postcondition
through a summary function, parametrized by the mid-loop state so it
covers every iteration. Derive invariant and summary together with
[deriving-invariants.md](../shared/deriving-invariants.md).

The summary function is part of the theorem's meaning: a claim stated
as `?R ==Int sumTo(N0)` says nothing until `sumTo`'s defining
equations say what it denotes. You own those definitions. Write them
in the `VERIFICATION-SUMMARIES` module of `verification.k`, which
`spec.k` imports; the later proving stage adds proof extensions to the
separate `VERIFICATION` module. If a repair changes summary definitions,
repeat the spec audit and all affected downstream checks.

```k
// verification.k, schematic APR example; adapt to the selected semantics
requires "semantics.k"

module VERIFICATION-SUMMARIES
  imports INT
  syntax Int ::= sumTo(Int) [function, total]
  rule sumTo(N) => (N +Int 1) *Int N /Int 2  requires N >=Int 0
  rule sumTo(N) => 0                          requires N  <Int 0
endmodule

module VERIFICATION
  imports VERIFICATION-SUMMARIES
  imports SEMANTICS
  imports BOOL
  // Proof extensions (lemmas, auxiliary claims) are added here by
  // the proving stage. The summaries module above is the theorem's
  // definitional layer; do not mix extensions into it.
endmodule
```

Definitional equations must be truthful, guarded, terminating, and
cover every use (the definitional summary class of the
[soundness contract](../shared/proof-extension-soundness.md)).
They must also evaluate on concrete arguments: a left-hand side such as
`f(A, I +Int 1)` never matches a literal, so write `f(A, I)` with a guard
and `I -Int 1` on the right.

When checking whether the entry claim matches concrete execution, use the
[concrete adequacy check](../shared/deriving-invariants.md#concrete-adequacy-check)
as a diagnostic.

Judge the drafted domain and meaning against the
[Gate B obligations](../shared/gate-b-adequacy.md). These apply whether
review is integrated with construction or requested as a separate audit.

---

## Check the drafted theorem

Review `spec.k`, `VERIFICATION-SUMMARIES`, and `SCOPE.md` together for
adequacy and summary faithfulness. Use `auditing-spec` for detailed review
guidance. A focused `intent-check validate` task can catch parser and module
errors before a proof is ready; a proof run already exercising the same
structure need not be preceded by duplicate validation.

---

## References

- [K functions, claims, and proof modules](../shared/k-claims.md), claim
  syntax, `requires`/`ensures`, labels, and proof-module restrictions.
- `proving-spec`, adds proof
  extensions to the `VERIFICATION` module and closes the APR claims.
- `validating-proof`, reviews proof-extension soundness and
  validates intent, trust, and evidence for a passing proof.

## Dispatch contract

- Inputs: the session ID, the target program(s), and the
  original
  contract; the task statement; on a redo, the failing audit artifact path.
- Produces: `spec.k`, the `VERIFICATION-SUMMARIES` module of
  `verification.k`, and `SCOPE.md`.
- Record: two sentences, the theorem stated and each chosen
  contract reading, plus the artifact paths. Do not restate claim
  bodies; the audit works from the files.
