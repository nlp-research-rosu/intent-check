# K functions, claims, and proof modules

Use this reference while writing `verification.k` helpers or `spec.k`
reachability claims.

## Functions and simplification

Declare deterministic helpers with `[function]`. Add `[total]` only when the
equations cover the complete input domain:

```k
syntax Int ::= sumTo(Int) [function, total]
rule sumTo(N) => (N +Int 1) *Int N /Int 2 requires N >=Int 0
rule sumTo(N) => 0                         requires N  <Int 0
```

### Attributes control rewriting, not truth

`[function]`, `[total]`, `[simplification]`, `[concrete]`, priorities, and
evaluator-related attributes change how K treats declarations and rules. These
attributes do not prove coverage, consistency, or soundness. Establish those
obligations under the
[proof-extension soundness contract](proof-extension-soundness.md) before
using the rules in a proof.

In particular, check total functions for complete guarded coverage and check
equations for overlap. A simplification rule is a trusted equation wherever its
guard applies; prover success does not establish that equation's truth.

Parenthesize Boolean comparisons: `A andBool B ==Bool false` parses as
`(A andBool B) ==Bool false`. Prefer `notBool B`.

Use `[simplification]` rules for algebraic facts the symbolic simplifier must
apply. Keep ordinary helper rules and functions in the verification module.
A proof module may contain claims and simplification rules, but not ordinary
rules:

```text
[Error] Compiler: Only claims and simplification rules are allowed in proof modules.
```

## Reachability claims

A claim rewrites a starting configuration to a destination configuration under
its precondition:

```k
claim [loop-inv]:
      <k> while (n > 0) { s = s + n ; n = n - 1 ; } => .K ...</k>
      <state> n |-> (N:Int => 0)
              s |-> (S:Int => S +Int sumTo(N)) </state>
  requires N >=Int 0
  [circularity]
```

- `requires` constrains the starting configuration.
- `ensures` constrains the destination when the cell rewrite alone does not
  express the postcondition.
- A variable introduced only on the right-hand side is existential and uses
  the `?X` form.
- `=> .K` requires the computation to be consumed on every covered path.

## Claim labels

Use `intent-check prove --help` for label spelling, claim selection, and
filtering
errors. See [writing-spec](../writing-spec/SKILL.md#claim-structure-and-reuse)
for claim reuse attributes.
