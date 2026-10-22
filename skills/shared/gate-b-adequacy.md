# Gate B: Intent adequacy obligations

Full obligations for Gate B of the
[soundness contract](proof-extension-soundness.md). Gate B asks whether
a sound theorem matches the intended property.

## B1. Input-domain alignment

Compare the formal precondition with the source contract, type information,
examples, and stated intent. Record every restriction rather than silently
strengthening the input contract.

An unparameterized or `Any`-element container contract means every element
class the fixed semantics represents, not the classes the examples happen to
use. Integer-only examples do not narrow an untyped `list` to integer lists:
cover each representable element class the reference computation is defined
on (dispatching per class with guarded projections where needed), exclude
classes only where the specified computation itself is undefined on them , 
identically in the program, and route classes the fixed model cannot
represent through the B2 model-boundary procedure below.

If the task requires the full source contract, finitely many fixed sizes,
examples, or bounded unrollings do not complete the required target proof unless
the source contract has the same bound. They may be reported as sound partial
progress under `SOUND-BUT-LIMITED`.

The program's own non-termination is never a reason to narrow. A claim is
partial correctness, so it holds on every input where the program runs
forever. Keep inputs on which you expect the program to diverge, or to skip a
loop, in the domain. When part of the domain behaves differently, cover it
with its own claim under a disjoint `requires`. Before excluding any input the
contract allows, run the program on one such input with `intent-check run` and
keep
the result; an exclusion without that witness is narrowing. If the semantics
rejects concrete runs, the witness is a proved claim showing the program's
behavior on that input, such as one pass of the loop body.

Domain narrowing means restricting which inputs or structures the theorem
covers. It does NOT include, and must not be conflated with:

- **Supplied-primitive value opacity.** When the structural theorem covers
  the full input domain and every residual value-level gap is exactly the
  contract of a named supplied primitive that the fixed semantics
  intentionally keeps opaque (with its rule domain recorded in the trust
  ledger), the theorem is complete relative to the granted trust boundary.
  Submit it as the successful target proof with the boundary explicit under
  Gate C; do not stop at partial and do not re-derive value semantics the
  fixed semantics does not define. Declining to prove real-analysis or
  bit-level facts about intentionally opaque arithmetic is not narrowing.
- **Contract-inherent divergence.** Inputs on which the specified
  computation itself is undefined (for example a division by zero forced by
  the stated formula on degenerate input) need not be covered by the
  positive theorem, provided the exclusion is stated and the program's
  behavior there is the same divergence the specification implies, not a
  silently substituted answer.

Neither exemption may be claimed for gaps a proof technique could close:
restricted lengths, missing constructors, unfinished branches, or guards
stronger than the source contract remain narrowing and remain
`SOUND-BUT-LIMITED`.

## B2. Language-model adequacy

Identify material differences between fixed semantics and the intended execution
model, including numeric representation, exceptional behavior, text encoding,
collections, external state, concurrency, and implementation-defined behavior.

A fixed-model representation boundary is not candidate domain narrowing.
When the program is faithful to the intended execution model and the only
residual gap is a value class or behavior the fixed semantics cannot
represent (a text-encoding subset, a numeric identification the model does
not make, an unmodeled value kind), the required response is:

1. prove the full contract over every value the fixed semantics represents , 
   no additional restriction of the candidate's own making;
2. record the model boundary explicitly in the trust ledger, with a concrete
   witness of the divergence where one exists;
3. submit the theorem as the target proof with that conditional adequacy
   boundary, rather than stopping at partial.

The exemption fails, and the case remains narrowing, the moment the
restriction originates in the candidate's theorem or program rather than the
fixed model, or the fixed model can represent the missing values and the
proof simply does not cover them.

A model boundary must be **witnessed, not assumed**. Before restricting a
theorem's domain on the ground that the fixed model cannot represent or
execute a value class, produce the stuck-execution or missing-constructor
witness: a concrete input in that class whose execution the fixed semantics
actually cannot complete. If the model executes the class (even through
generic constructors such as an unrestricted integer-sequence string), the
class belongs in the theorem's domain, and excluding it is candidate-caused
narrowing, mislabeling it a model boundary in the trust ledger converts a
provable obligation into a false limitation claim.

The exemption also fails when the report asserts fidelity it never checked.
Never state that a fixed-model primitive retains the intended language's
behavior on edge values, not-a-number, signed zero, infinities, rounding at
representation extremes, comparison on mixed numeric kinds, without a
checked witness on both sides of the bridge. If the primitive diverges on
such a value, that is a model boundary to record under the procedure above;
if it agrees, keep the checking evidence. An unchecked equivalence assertion
about a load-bearing primitive converts a recordable boundary into a false
claim, and the whole exemption is forfeited with it.

## B3. Summary-to-property adequacy

Separate a summary's execution characterization from the theorem that the
summary has the requested human-facing meaning. Label that bridge as formally
proved, conditionally trusted, or empirically supported.

## B4. Implementation-to-intent alignment

When the theorem faithfully describes the program but the program conflicts
with its specification, report an implementation/specification discrepancy. Do
not make the proof claim behavior the program does not have.
