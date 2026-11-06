# Proof correctness

The prover establishes claims under the supplied semantics and helper rules.
It cannot establish that those rules are true merely by using them, or that
the claim expresses the user's intended property.

## Program and property

The initial configuration must execute the actual program with the intended
bindings, arguments and environment. The destination constrains its actual
result and observable state, including relevant exceptions and control effects.
A satisfiable precondition and a constrained final result distinguish a useful
theorem from vacuous success.

Symbolic inputs cover the agreed domain. Fixed examples, bounded lengths and
unfinished branches are narrower results unless the request has those bounds.
A difficult case or possible nontermination does not justify strengthening a
partial-correctness precondition. Untyped containers are not integer-only merely
because examples contain integers.

Language-model limitations differ from proof limitations: unsupported value
representations or operations come from the pinned semantics; unproved branches
come from the claim. Ground model-boundary claims in the actual definition or
execution evidence. State the represented domain and any discrepancy with the
intended language, rather than implying full-language coverage.

## Definitions, lemmas and assumptions

| Addition | What justifies its use |
|---|---|
| Mathematical summary | Truthful equations defining the intended value, with covered guards, consistent overlaps and terminating recursion. |
| Auxiliary lemma | A derivation over its complete guard from fixed semantics or established mathematics. |
| Rule replacing program execution | A machine-checked connection to that exact execution, proved without the replacement rule. |
| External primitive or admitted claim | An explicit assumption; conclusions depending on it remain conditional. |

Attributes such as `[total]`, `[simplification]` and priority control evaluation;
they do not supply a justification. A rule must be valid everywhere its pattern
and guard match, not only on a convenient example path.

An equation that asserts the target property about the program's result is the
theorem assumed, not proved. A result-characterizing property belongs in an
invariant or auxiliary claim whose connection to execution is established.

## Summarizing execution faithfully

Prefer executing the fixed semantics and summarizing its resulting value.
Replacing execution also requires preservation of lookup, argument evaluation,
state changes, exceptions and control transfer. The replacement's match domain
cannot exceed its connection theorem's domain: wildcards, framed cells and
weaker guards broaden that domain.

For example, this replacement does not justify itself:

```k
rule <k> invoke(F, ARGS) => summary(F, ARGS) ... </k>
```

For program-defined `F`, the supporting claim must connect its actual body and
invocation state to `summary`, independently of this rule. A theorem for one
continuation does not justify arbitrary continuations admitted by `...`.
Using the same opaque symbol in this rule and the postcondition proves no
connection to what `F` computes.

## Evidence and conclusions

Proof evidence belongs to exact program, claim, helper, semantics and control
inputs. Changed inputs or assumptions invalidate dependent evidence; unchanged
evidence can be reused. Per-claim closure, admitted claims and unresolved leaves
matter more than a process exit code; see [results](running-k.md#reading-the-result).

Concrete runs, differential comparisons and false-postcondition checks can expose
wrong configurations, equations or unconstrained results. They answer specific
uncertainties; they are not mandatory stages or substitutes for universal proof.
A timeout or parser error is not a counterexample or a successful negative control.

Describe the established property, covered domain, assumptions and limitations
in plain language. Distinguish proved facts, conditional conclusions, empirical
support and unresolved work. Retain commands, task/session IDs and evidence
paths for the conclusions actually reported.
