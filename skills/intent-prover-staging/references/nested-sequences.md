# Nested sequence proofs

Iteration rules match the pinned semantics' raw constructors. A custom wrapper
such as `xsSeq(IS)` may hide the nil/cons structure, leaving symbolic iteration
stuck even when fixed-size examples close. Symbolic operational inputs therefore
use the semantics' constructors; custom representations can still be useful for
mathematical summaries outside the execution state.

## Outer and inner induction

- Recursive domain predicates describe element types and shape without fixing
  a finite size: for example `allXs(S)` over the raw constructors.
- A loop claim exposing nil/cons cases supplies one layer of induction. An
  inner loop's claim relates its sequence to a structurally recursive summary.
- The outer invariant carries the inner summary's value. Unvisited inner
  sequences remain symbolic heap entries rather than being unfolded together.
- An input pattern's empty/cons alternatives must cover the intended domain;
  successful concrete instances do not establish arbitrary nesting or length.

Nested symbolic induction can exhaust memory because it multiplies structural
cases. The residual and resource evidence distinguish that limit from a wrong
claim. An unproved nested case remains unresolved; replacing iteration with a
shortcut needs an independent execution-equivalence theorem.

See [invariants](deriving-invariants.md) for summary equations and
[sort refinement](sort-refinement.md) for dynamic element dispatch.
