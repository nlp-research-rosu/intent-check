---
name: writing-semantics
description: 'Use for formal proofs with K: prepare a candidate K language definition for a future Intent Check service release; live use is limited to immutable bundled semantics IDs. Not for ordinary code review.'
---

## Artifact contract

`semantics.k` is a candidate definition of the language constructs exercised
by the program set. This is an Intent Check service maintainer workflow outside live prove
mode. A candidate cannot be selected in prove mode until the service freezes it,
assigns a versioned ID, and lists that ID through its client. Never point a
live `semantics.json` at an unbundled source tree.

| State | Action |
|---|---|
| A suitable bundled ID exists | Stop; live prove mode must use that immutable ID |
| A candidate gets stuck in maintainer testing | Extend only the unmodeled construct |
| A bundled ID gets stuck | Preserve it and record the witnessed boundary |
| None exists | Create the smallest executable semantics in a dedicated source root |

The result must parse the target programs, execute the modeled constructs, and
stop visibly on anything outside its supported subset.

## 1. Inventory the construct set

Read the target code and representative examples. List every expression,
statement, control-flow form, and state component they exercise. Use that list
as the scope: every listed construct needs syntax and behavior; absent
constructs stay unmodeled.

## 2. Choose the representation

Default to the smallest abstract syntax that stays recognizably aligned with the
source program. Use concrete source grammar when parsing the original files is
part of the goal. Use a lower IR only when the input already arrives in that
form, and use pure K functions only for stateless computations.

Record the choice and its reason in `smoke/RESULTS.md`. Do not present several
equivalent representations without selecting a default.

## 3. Define the configuration

Add one cell for each state component in the inventory:

- `<k>` for the current computation
- a bindings/state cell for program variables
- heap, stack, I/O, or other cells only when the target constructs require them

Keep the initial configuration explicit and avoid cells that no rule reads or
writes.

## 4. Add one construct at a time

For each inventory item:

1. Add the smallest syntax production that represents it.
2. Add its evaluation order when subterms must reduce first.
3. Add the operational rule or rules.
4. Run a focused example before moving to the next construct.

When creating a definition from scratch, adapt the single
[stateful semantics template](../shared/semantics-template.md). For concrete
grammar, read [K syntax and operational semantics](../shared/k-syntax.md)
for precedence groups, brackets, identifier tokens, cells, and rewrite syntax.

If a loop or recursive construct will be summarized by an invariant claim,
ensure its rules return to a stable recurring configuration. The claim must
match the term and cells the semantics actually reaches; do not copy an
unrelated loop encoding solely because it appears in an example.

## 5. Smoke-test the semantics

Compile and run every representative program using
[running-k.md](../shared/running-k.md):

- Compare the final configuration with a hand-calculated result.
- Include boundary behavior such as a loop with zero iterations.
- Confirm that each inventory construct is exercised by at least one example.
- Preserve the exact Intent Check service submission, task ID, K exit, and logs for
  failures.

Record the run: keep each smoke program under `smoke/` and write
`smoke/RESULTS.md` with, per program, the exact HTTP submission, task
ID, K exit, actual final configuration, and hand-calculated expected
result. The semantics auditor replays and extends these; an
unrecorded smoke run is an audit finding.

Do not proceed to `writing-spec` until the examples execute as intended.

## 6. Extend from a stuck state

When maintainer testing stops with a residual term in the candidate, then:

1. Read the front of `<k>` and the relevant side conditions.
2. Identify the single missing or non-applicable rule.
3. Add the minimum syntax or behavior needed for that construct.
4. Rerun the failing example.
5. Rerun earlier examples to detect regressions.

For a read-only definition, preserve the unmatched term as the model-boundary
witness instead. The unmatched term is evidence of an incomplete model, not
permission to widen the semantics speculatively.

## Dispatch contract

- Inputs: the target program(s), task statement, any candidate source-root
  path, and explicit edit permission.
- Produces: the candidate semantics source tree, `smoke/` programs, and
  `smoke/RESULTS.md`. It does not assign an Intent Check service semantics ID.
- Report back: two sentences, what was modeled and what was left
  unmodeled, plus the artifact paths. Do not restate rule contents; the audit
  works from the files.
