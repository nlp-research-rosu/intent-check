# Gate A: Real-program soundness obligations

Full obligations for Gate A of the
[soundness contract](proof-extension-soundness.md). A failed obligation
means the proof does not establish the stated theorem about the
program.

Before admitting an operational bridge, require a bridge-free universal
connection theorem over the bridge's complete match domain. The theorem must
not import the proposed bridge; it must establish the connection using fixed
semantics and independently justified theory. Finite tests do not satisfy this
precondition.

## A1. Program identity and body sensitivity

Let every relevant program-defined operation execute under fixed semantics, or
prove an auxiliary reachability claim from its exact invocation configuration,
binding, body, arguments, and environment to the stated summary. When practical,
mutate the body temporarily: a material body change must invalidate or change
the connection proof.

This pattern is not justified by an opaque result alone:

~~~k
rule <k> invoke(F, ARGS) => resultSummary(F, ARGS) ... </k>
~~~

If F denotes program-defined code, connect resultSummary to execution of that
code before using it in the caller's proof.

## A2. Operational-state preservation

For every operational bridge, enumerate the cells read, written, preserved, or
abstracted by the skipped execution. Preserve returned values, state changes,
resource changes, exceptions, output, and control effects exposed by the active
semantics. Prefer executing fixed semantics and summarizing the resulting value.

## A3. Binding, evaluation, and control fidelity

Preserve lookup, argument evaluation, evaluation order, control transfer, and
exceptional behavior. A textual operation name does not establish the selected
binding. If a bridge pins a binding, prove its environment and guard select that
binding.

### Value fidelity for result-bearing abstractions

An abstraction is **result-bearing** when its value can affect a branch,
returned value, observable state, exception, or any summary used by the final
claim. First classify its origin. A fixed external primitive intentionally
outside the theorem may remain opaque when the proof is interpretation-
parametric or states every value-level conclusion conditionally on its named
contract. A program-derived abstraction has no such boundary: if an operational
bridge replaces fixed execution with a fresh or opaque symbol, require a
machine-checked connection theorem over the bridge's complete domain showing
that fixed semantics produces exactly that value. Exact syntax, bindings, and
context do not establish value equivalence.

This shape is circular rather than justificatory:

~~~k
rule <k> programExpression(X) => oracle(X) ... </k>
claim <k> program(X) => resultUsing(oracle(X)) </k>
~~~

Using the same fresh symbol in both the operational bridge and the postcondition
only makes the claim follow under an arbitrary interpretation of `oracle`; it
does not prove what the program expression computes. A program-defined
condition or property cannot become a trusted primitive by being opaque.
Execute it, define the summary truthfully and prove the connection, or reject
the proposed bridge and follow the Gate A repair transition. Finite tests can
expose a bad oracle but cannot replace the universal connection theorem.

For program-derived abstractions, value-sensitivity witnesses can diagnose
uncertain value connections. Choose satisfiable ground cases with
distinct fixed-semantics values, compare fixed and bridge-enabled execution,
and attempt the opposite ground interpretation of the abstraction. Any admitted
wrong branch, result, or observable state is a Gate A failure.

### Context containment for operational bridges

For every operational bridge, the bridge match domain must be a subset of its
justification domain. Compare complete configurations, not only the term being
summarized: include the active continuation, control stack, guards, bindings,
and every framed or omitted cell. A frame, wildcard, weaker guard, or omitted
cell broadens the bridge unless the supporting theorem is equally general or a
separate theorem proves that context irrelevant.

An exact auxiliary theorem over one continuation does not justify a rule over
an arbitrary continuation. Schematically:

~~~k
// Established only for this suffix:
claim <k> region(X) ~> finish(X) ~> #end => result(X) ... </k>

// Not derived: `...` admits suffixes the claim did not cover.
rule <k> region(X) => Return(result(X)) ... </k>
~~~

The second rule also introduces abrupt control that may discard or unwind the
framed computation. A bridge involving return, frame popping, exceptions, loop
control, cleanup, or another control effect must match the exact control context
or be justified by a theorem quantified over every context it accepts. Rule
priority can make a bad bridge preempt fixed semantics; it never supplies the
missing equivalence.

An operational-sensitivity mutation can test an uncertain bridge: materially
change the displaced execution or an immediate continuation admitted by the
bridge.
The connection proof must fail or its result must change when fixed execution
changes. This is separate from a postcondition mutation, which tests whether the
claim constrains its result but not whether a bridge preserves execution.

## A4. Logical consistency and rule validity

Require every equation to be true wherever its guard applies. Check equations
for the same symbol pairwise: guards must be disjoint or right-hand sides must
agree on their overlap. Check totality coverage, recursive descent, concrete and
simplification interactions, and totalization guards.

Do not justify a globally false rule only by calling its bad cases unreachable.
An off-path false rule blocks full validation until narrowed because later
claims or reuse can expose it.

## A5. Result constraint and non-vacuity

Exhibit a realizable state satisfying the precondition. Confirm that the final
claim constrains the relevant result or state and that required auxiliary claims
are exercised. If result sensitivity remains uncertain, mutate the result or
postcondition to a false alternative and inspect whether the prover rejects
it for a meaningful witness. A mutation is diagnostic evidence, not a
substitute for checking satisfiability and the claim's result constraint.
