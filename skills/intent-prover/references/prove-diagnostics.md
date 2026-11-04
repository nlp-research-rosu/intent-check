# Prove: diagnostics

Read the saved task result, stdout and stderr first. Residual states are not
automatically counterexamples. If a validated proof task throws an internal exception,
it may have failed before printing a residual; inspect boundary cases and a focused
claim rather than assuming a parser error or bisecting valid sources.

## Bounded inspection

Isolate the affected claim and compare residuals at nearby increasing `--depth`
bounds chosen from the observed trace. New program points show progress; the same
stuck term suggests a missing rule or undecidable guard; growing helper terms suggest
symbolic recursion; repeated loop heads suggest failed circularity matching.
Depth limits rewrite steps, not wall time; a single step may still diverge. Remove
the bound and recheck the final positive claim. Respect the existing session budget.

## Choose by symptom

| Symptom | Check or repair |
|---|---|
| Missing module or wrong definition | Verify the pinned registry entry, imports and every transitive `--source`; do not upload bundled semantics |
| Ordinary rule rejected in spec module | Move helper rules to `verification.k`; spec modules allow claims and simplifications |
| Unused filtering labels | Read `prove --help`; check fully qualified labels and selected/excluded/trusted combinations |
| Almost immediate stuck lookup | Compare cell skeleton, scope chain, bindings and continuation with fixed configuration/rules or a working claim; generalize values, not required structure |
| Loop invariant never applies | Check `[circularity]`, callers' `[depends(...)]`, and the complete reached LHS shape: head symbols, arguments, frames, cells and path condition |
| Symbolic helper grows forever | Identify the recurring guard; use a faithful decidable closed form or justified base/step induction and folding, not a false approximation |
| Run timed out or disconnected | Inspect saved task status; recover accepted work with `task wait`, not another submission |

Use the actual recurring loop representation, not an unrelated example encoding.
If fixed semantics cannot represent it faithfully, record a witnessed model gap
instead of rewriting the live semantics. Recheck isolated obligations before callers.

## Dynamic sorts

`isS(V)` does not necessarily refine `V:Super` to a static `S` for backend matching.
When a fixed operation stays stuck, a guarded total projection can expose the exact
subsort under its definedness predicate. Adapt the upstream K `ceils.k` pattern:
characterize the partial cast's definedness, orient total/partial casts only under
that guard, preserve definedness and collapse `project(X:S)` to `X`.
Any dispatch twin must restate the fixed equation over precisely the same match
domain, not widen it or introduce an unconstrained value. Retain the derivation and
check the obligations in [prove-evidence.md](prove-evidence.md). Bounded instances
or force-cast/interception rules do not repair the unbounded theorem.

## Nested containers

Use the semantics' raw constructors with recursive domain predicates, not custom
embedding wrappers in operational positions. Expose one constructor layer per
circularity, with separate empty/cons obligations. Prove inner-loop summaries as
total structural functions over raw constructors; keep unexposed inner sequences
abstract in the outer invariant. If symbolic induction still exhausts resources,
record the evidence rather than adding iterator accelerators that assume execution.

## Intentionally opaque external primitives

Opacity is only for fixed operations intentionally outside the theorem, not
program-defined helpers. A `[function, total, no-evaluators]` wrapper with no applicable
proof-time rule can thread an opaque term while a guarded `[concrete]` rule supplies
ground behavior where supported. `[no-evaluators]` is metadata, not a switch disabling
rules; `[concrete]` rules can also fire on ground terms during symbolic proof and hit
missing hooks. Inspect actual applicability and use literals rather than unsupported
computed constants where appropriate. Keep value-level conclusions conditional on
the explicit external contract. Finite differential checks support only tested cases,
never a universal value theorem or program-derived execution connection.
