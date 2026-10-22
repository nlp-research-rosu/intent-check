# Deriving invariants, summaries, and proof obligations

Use this scaffold when stating what a loop computes: it derives the
loop-invariant claim and the summary function together, and lists the
obligations any loop-bearing proof must discharge.

## Deriving the loop invariant

The loop invariant captures what is preserved at the loop head on every
iteration. To derive it:

1. **Identify the postcondition.** For the entry claim it is the condition on
   the final state, e.g. `n == 0` and `s == sumTo(N0)`.

2. **Ask: what is true at the loop head that implies the postcondition when the
   loop exits?** The loop exits when the guard is false (`n == 0`). At that
   point the invariant must reduce to the postcondition.

3. **Parametrize by the mid-loop state.** Replace the initial values by symbolic
   variables `N` (remaining counter) and `S` (accumulated so far). The invariant
   is: "with `n |-> N` and `s |-> S` at the loop head, the loop ends with `n |->
   0` and `s |-> S + sumTo(N)`."

4. **Check the base case algebraically.** When `N == 0` the guard is false, the
   loop exits immediately, and the postcondition becomes `S == S + sumTo(0)`,
   i.e. `sumTo(0) == 0`, true by the definition of the summary function.

5. **Check the inductive case algebraically.** When `N > 0`, one iteration runs:
   `n` becomes `N - 1`, `s` becomes `S + N`. Applying the invariant to the new
   state gives `n |-> 0` and `s |-> (S + N) + sumTo(N - 1)`. The obligation is
   `(S + N) + sumTo(N - 1) == S + sumTo(N)`, which the chosen closed form
   reduces to solver-supported integer arithmetic in this example.

The invariant ties the running partial sum `S` and the remaining count `N` to
the final postcondition through the summary function `sumTo`. The summary
function belongs in `verification.k`, not in the spec module.

## Choose the summary representation

When an equivalent closed form exists in a theory the target solver can decide,
prefer it; for the sum example, `N*(N+1)/2` reduces the obligation to supported
integer arithmetic. If no faithful closed form exists, keep the recursive
definition, it may be the only exact specification of the result. Make its base
and step equations explicit, and use induction, folding, or summary lemmas so
the proof does not depend on unbounded evaluator unfolding. A recursive
equation can otherwise keep expanding while its symbolic guard remains
entailed; see
[symbolic-recursion debugging](symbolic-recursion.md).

Over sequences, state summaries as **structural recursion** (guarded total
recursion over the constructors), never index arithmetic over positions.
When a result must start at a fixed element, pin that head positionally,
e.g. two mutually recursive helpers, one per position class, never derive
it from the parity of the *remaining* length: that construction silently
flips the head for one parity of the total length. When a loop body
alternates by parity, phrase the invariant so one application of the
invariant claim covers one full period.

## Concrete adequacy check

Before proving, run the program with `intent-check run` on at least two inputs
satisfying the precondition: a boundary input and a larger one, chosen to
distinguish each phase or branch of the summary (e.g. both parities of a
length parameter, for an alternating loop). Check the entry claim's whole
right-hand side against each final state: every cell value it pins, and every
postcondition with its summary functions evaluated on those literals. A
summary that does not reduce on literals fails the check. This costs seconds;
a wrong postcondition found after the proof closes costs the whole proof.

## The three obligation shapes

Every loop-bearing K proof discharges three obligations:

1. **Base case**, the invariant holds when the loop guard is already false: the
   postcondition it claims must follow from doing nothing.
2. **Inductive case**, assuming the invariant at the loop head, one iteration
   of the loop body must re-establish it (or reach the postcondition, if the
   guard is now false).
3. **Whole-program discharge**, instantiating the loop-invariant claim at the
   point the entry claim first reaches the loop head must produce exactly the
   entry claim's postcondition.

A complete proof records how each obligation is discharged.
