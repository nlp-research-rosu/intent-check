# Prove: specifications

## Scope and meaning

Begin `SCOPE.md` with `## Property in plain language`: permitted inputs, result,
observable state changes, conditions and exclusions, without K notation. State when
termination is not proved. Then record the exact entry computation and program bodies,
input domain, observable cells, chosen contract readings and remaining obligations.
Keep this synchronized with claims and summary definitions.

Compare preconditions with the original contract, not just examples. An untyped or
`Any` container covers every representable element class on which the computation
is defined. Finite sizes or bounded unrollings do not replace an unbounded theorem.
Do not exclude inputs merely because the program may diverge or a proof is difficult;
split genuinely different behavior into claims with disjoint guards. Before excluding
an allowed class, retain a concrete execution witness, or a focused behavior claim
when concrete execution is unavailable. Record model boundaries separately from
restrictions introduced by the candidate proof.

Inspect load-bearing operator rules, bindings and value representations in the
selected semantics. Do not assume familiar spelling means familiar behavior.
For model-boundary handling and final scope assessment, use [prove-evidence.md](prove-evidence.md).

## Essential K structure

Adapt cell shapes and syntax to the pinned semantics; this is a schematic shape:

```k
requires "verification.k"
module SPEC
  imports VERIFICATION
  claim [entry]:
    <k> actualProgram(N:Int) => ?R:Int </k>
    <state> S => ?S </state>
    requires N >=Int 0
    ensures ?R ==Int expected(N)
    [depends(loop-inv)]
  // Define loop-inv as a separate reachability claim over the actual loop head.
endmodule
```

`requires` constrains initial configurations; `ensures` constrains final values.
Use `?X` for RHS variables not bound on the LHS. Constrain the produced value or
final state, not a symbol bound to a cell's overwritten initial value. `.K` means
no computation remains; `...` frames additional context and broadens a match.
Use concrete program identifiers as the grammar defines them, not accidental K variables.

Give claims stable labels. APR uses a claim as its own invariant only with
`[circularity]`; callers must name reused claims in `[depends(...)]`. An outer
invariant using an inner invariant needs both. Prior task success does not itself
make a claim available. Use fully qualified labels as required by command help.
`--trusted` admits a selected claim without proving it; list it as an assumption
and retain explicit dependency attributes. Never turn a proved claim into an ordinary
rewrite rule merely to reuse it.

Keep claims in the spec module. Ordinary helper rules belong in `verification.k`;
the spec module allows claims and proof-local `[simplification]` rules, not ordinary
operational rules. Import helpers through `VERIFICATION`; keep mathematical
definitions in `VERIFICATION-SUMMARIES` so theorem meaning is distinguishable from
execution shortcuts. Include all local modules in the submitted sources.

## Invariants and summaries

Derive an invariant from the actual recurring configuration and accumulator update,
including the zero-iteration case, inductive step, exit and observable state. For nested
loops, prove the inner contract before using it in the outer one. Generalize values
without erasing structural well-formedness needed by the execution rules.

A summary must have truthful, guarded equations covering every use. Check termination,
guard overlap and agreement, totalization and concrete/simplification interactions.
`[function, total]` does not prove an arbitrary definition correct. Prefer a faithful
solver-friendly closed form where available; otherwise keep structural recursion
and prove the needed induction/folding lemmas. Match concrete arguments directly:
use `f(A, I)` with guards rather than an LHS like `f(A, I +Int 1)` that misses literals.

Separate “execution produces this summary” from “this summary has the requested
meaning”; both connections need justification. Thread result properties through
invariants rather than installing the desired postcondition as a simplification axiom.
When definitions or assumptions change, revisit scope and all dependent evidence.
