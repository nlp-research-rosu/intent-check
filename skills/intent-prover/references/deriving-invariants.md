# Invariants and summaries

A loop invariant relates an arbitrary intermediate state to the eventual result.
It is more general than a claim describing only the initial invocation, allowing
the same claim to cover successive iterations.

## Summation example

For a loop that adds `n` to `s` and decrements `n`, a useful reachability invariant is:

> From loop-head state `n = N`, `s = S`, execution ends with
> `n = 0`, `s = S + sumTo(N)`, for `N >= 0`.

| Case | Reasoning |
|---|---|
| Exit (`N = 0`) | No iteration; `sumTo(0) = 0`, so the final accumulator is `S`. |
| Step (`N > 0`) | The body reaches `N - 1`, `S + N`; invariant reuse gives `(S + N) + sumTo(N - 1) = S + sumTo(N)`. |
| Entry | Instantiate `S` and `N` from the caller's actual loop-entry state to obtain its postcondition. |

The claim describes the actual recurring K configuration, not just the
source-level loop. Self-reuse needs `[circularity]`; a caller uses
`[depends(label)]`. See [K claim syntax](k-claims.md#reachability-claims) and
[matching failures](proof-debugging.md#invariant-does-not-apply).

## Summary representation

An equivalent closed form such as `N *Int (N +Int 1) /Int 2` can reduce recursive
reasoning to arithmetic, though solver support still matters. A recursive
definition is appropriate when no faithful closed form exists; base/step
equations and justified folding lemmas connect it to the loop's update.

Structural recursion follows sequence constructors and usually exposes the
induction better than symbolic index arithmetic. For alternating behavior,
include the phase in the invariant or cover a full period per application.
Parity of the remaining length is not necessarily parity of the original position.

Summary equations must reduce on concrete boundary values and denote the
requested result, not merely a convenient quantity. Repeated symbolic expansion
without a reachable base case calls for induction or folding, not a larger depth
limit. The helper belongs in `verification.k`; the claim proves its relationship
to program execution.
