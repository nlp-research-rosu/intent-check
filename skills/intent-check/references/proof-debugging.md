# Reading unclosed proof states

A residual is a reached state that did not close against the claim. Its
computation, cells and path conditions distinguish a wrong statement from a
missing proof argument. An isolated claim or `--depth` can expose that state;
bounded execution is diagnostic evidence, not a final positive proof.

## Execution stops immediately

An unresolved lookup or entry operation often indicates a malformed initial
configuration. Scope chains, heap references, map skeletons and continuations
must match the pinned semantics' rules. Symbolic input values need not imply
arbitrary runtime structure. Compare with the configuration declaration and
the rules matching the residual; mathematical lemmas cannot repair an invalid
entry state. A genuinely unsupported operation is a semantics limitation.

## Invariant does not apply

Reuse requires the reached configuration and path condition to match the
claim's left-hand side and precondition. Source-level similarity is insufficient:

```k
repeatUntil(Done, Body) ~> KREST
```

does not match `loop(Body, Done) ~> KREST`. Different head symbols, arguments,
frames, cells or guards can all prevent reuse. The invariant belongs at the
actual recurring state. `[circularity]` enables self-reuse and `[depends(label)]`
enables cross-claim reuse; neither attribute repairs a state mismatch.

## A helper expands indefinitely

A recursive guard can remain entailed for a symbolic argument even though
concrete calls terminate. Growing helper terms are not progress through the
program. Equivalent closed forms, induction or justified folding lemmas can
make the obligation finite. Keep the summary faithful: making program-defined
code opaque merely to close the proof replaces the theorem with an assumption.

## Execution finishes but the claim stays open

Compare actual final values with destination patterns. Common causes include
pinning initial machine state at return, reading the wrong result object,
inconsistent helper equations or a postcondition stronger than the program.
A remaining path may expose a real bug, but a stuck leaf alone is not a
counterexample. A counterexample needs a realizable input and violated property.

## Structural and solver limitations

- A symbolic supersort value does not necessarily match a subsort rule even
  with a type predicate: [sort refinement](sort-refinement.md).
- A custom container wrapper may hide the constructors iteration expects:
  [nested sequences](nested-sequences.md).
- An unavailable arithmetic hook differs from an unproved value property:
  [external primitives](opaque-primitives.md).
- Task errors, timeouts and result fields: [runtime diagnostics](running-k.md#diagnostic-entry-points).
