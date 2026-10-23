# Dynamic-to-static sort refinement: guarded total projections

Symptom: iteration or dispatch over a heterogeneous dynamic supersort yields a
symbolic `V:Super`, while the semantics' operation rules pattern-match on a
static subsort (`op(X:S, …)`). A Boolean path condition `isS(V)` does **not**
refine `V` to sort `S` in the Haskell backend: the fixed rule stays stuck on
`V:Super`, so fixed-size claims close (every element becomes concrete) while
the unbounded claim unrolls or accumulates unsolved existential witnesses.
Neither escape is acceptable: a bounded-size theorem is a material domain
restriction (`PARTIAL`, not success), and an operational rule that force-casts
or intercepts the program manufactures a passing result and fails the
soundness gates.

The sound repair is the guarded total-projection idiom (the upstream K
`ceils.k` family). Introduce a total twin of the partial subsort cast and keep
every use guarded:

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

When the backend has no hooks for the target sort at all (structure-only
reasoning), the collapse rule alone is enough: `projectSTotal(X:S) => X`
plus `[no-evaluators]` keeps the symbol uninterpreted everywhere else.

Then give the stuck operations **guarded dispatch twins**: simplification
rules over supersort variables that restate the semantics' own equation with
the projection applied under the exact guard.

```k
rule op(V:Super, W:Super) => opS(projectSTotal(V), projectSTotal(W))
  requires isS(V) andBool isS(W) [simplification]
```

For sequence domains, pair this with a recursive total domain predicate
(`allS(.Seq) => true`, `allS(cons(V, R)) => isS(V) andBool allS(R)`) as the
claim's precondition, so the guard on each unrolled head is entailed.

Soundness obligations, classify each piece under the shared
[proof-extension contract](proof-extension-soundness.md) before use:

- Every dispatch twin must be **the same equation** as an existing rule of
  the fixed semantics, restated over the supersort; its guard must cover
  exactly the original static match domain (match-domain containment and
  value fidelity, a twin that widens, narrows, or redirects the operation
  is an unsound bridge).
- The projection has **no evaluators and no proof-time rule** beyond
  collapse/orientation; it can never produce a value out of nothing (an
  unconstrained result symbol is the oracle bug).
- Orientation rules carry `preserves-definedness` and fire only where the
  definedness predicate is entailed.
- These extensions are derived lemmas or definitional summaries over the
  fixed semantics, not new trusted primitives, so validate them with the
  usual mutation and vacuity probes.
