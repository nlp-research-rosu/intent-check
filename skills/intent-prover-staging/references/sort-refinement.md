# Dynamic-to-static sort refinement: guarded total projections

Symptom: iteration or dispatch over a heterogeneous dynamic supersort yields a
symbolic `V:Super`, while operation rules pattern-match on a static subsort
(`op(X:S, …)`). A Boolean path condition `isS(V)` need not refine the term's
syntactic sort. Fixed-size examples can therefore close while an unbounded
claim stays stuck. Restricting sizes narrows the theorem; an unjustified
force-cast changes the execution rather than proving it.

A guarded total projection can expose the subsort while preserving definedness.
The following schematic pattern depends on the pinned definition's cast syntax,
sort relations and supported attributes:

```k
syntax Bool ::= definedProjectS(Super) [function, total]
rule definedProjectS(V:Super) => isS(V)

syntax S ::= projectSTotal(Super)
  [function, total, symbol(projectSTotal), no-evaluators]

// #Ceil characterization of the built-in partial cast
rule #Ceil({@V:Super}:>S)
  => ({ definedProjectS(@V) #Equals true } #And #Ceil(@V))
  [simplification]

// orientation pair at the cast boundary
rule projectSTotal(V:Super) => {V}:>S
  requires definedProjectS(V)
  [concrete, simplification(10), preserves-definedness]
rule {V:Super}:>S => projectSTotal(V)
  requires definedProjectS(V)
  [symbolic(V), simplification, preserves-definedness]

// sort-based collapse and idempotence
rule projectSTotal(X:S) => X [simplification]
rule projectSTotal(projectSTotal(V)) => projectSTotal(V) [simplification]
```

For structure-only reasoning, `projectSTotal(X:S) => X` collapses values already
in the subsort. Without other applicable equations, the symbol stays
uninterpreted elsewhere; `[no-evaluators]` is metadata, not an evaluation switch.

A **guarded dispatch twin** restates an existing equation over supersort
variables, using projections under the original match condition:

```k
rule op(V:Super, W:Super) => opS(projectSTotal(V), projectSTotal(W))
  requires isS(V) andBool isS(W) [simplification]
```

For sequence domains, a recursive total domain predicate
(`allS(.Seq) => true`, `allS(cons(V, R)) => isS(V) andBool allS(R)`) as the
claim's precondition establishes the guard on each unrolled head.

## Why the projection is valid

- Every dispatch twin must be **the same equation** as an existing rule of
  the fixed semantics, restated over the supersort; its guard must cover
  the original static match domain. A different guard or value requires its
  own equivalence argument.
- The projection has **no evaluators and no proof-time rule** beyond
  collapse/orientation; it can never produce a value out of nothing (an
  unconstrained result symbol would assume the missing value connection).
- Orientation rules carry `preserves-definedness` and fire only where the
  definedness predicate is entailed.
- These are equations derived from fixed semantics, not newly trusted
  primitives. [Proof correctness](proof-correctness.md) explains the distinction
  between a derivation, an execution replacement and an assumption.
