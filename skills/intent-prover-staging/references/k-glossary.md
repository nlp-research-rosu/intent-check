# K spec-writing glossary

Use this reference to turn a program property into a K claim. It explains the
notation and shows how the pieces fit in a spec file. Cell names, entry terms
and return conventions come from the selected semantics, not from a universal
template. The examples below are schematic, not completed proofs.

## Claims and state

| Notation | Meaning |
|---|---|
| `claim [label]: ...` | A named reachability statement for the prover to establish. |
| `<k> ... </k>` | The computation cell; other cells can hold a heap, locals, stack or runtime state. |
| `LHS => RHS` | Starting content and required destination. Inside a cell, this states how that cell changes. |
| A cell without `=>` | Its pattern constrains both the starting and destination state; it is not merely an input declaration. |
| `requires P` | Precondition on the starting state. Cover the requested domain rather than assuming the desired result. |
| `ensures Q` | Constraint on the destination, including the returned value or final state. |
| `X:Int`, `M:Map` | A variable with a K sort. Python integer objects still need the selected semantics' heap representation. |
| `?R:Int` | An existential destination variable. Constrain it to the intended result. |
| `.K`, `.Map`, `.List`, `.Bag` | Empty computation or collection of the named sort. |
| `A ~> B` | Computation sequence: process `A`, then `B`. |
| `...` in a cell pattern | Frames the rest of the cell rather than spelling it out. Do not frame away behavior the property must observe. |
| `+Int`, `>=Int`, `andBool` | K's sorted arithmetic and Boolean operators, not source-language syntax. |

## Write a spec file

Assume the imported definition declares `increment(Int)`, executes its body,
and leaves the returned integer in `<k>`. A specification could then be:

```k
requires "verification.k"

module SPEC
  imports VERIFICATION

  claim [increment-result]:
    <k> increment(N:Int) => ?R:Int </k>
    requires N >=Int 0
    ensures (?R ==Int N +Int 1) andBool (?R >=Int 0)
endmodule
```

Here `N` is the arbitrary input, `?R` is the final result, `requires` states the
allowed inputs, and `ensures` states what execution must establish. The two
postconditions are joined by `andBool`. The claim neither defines `increment`
nor establishes the result merely by stating it.

The file dependency and imported module must expose the actual program and
selected semantics. Keep ordinary helper definitions in `verification.k`;
`spec.k` contains claims and, when needed, simplification rules.

## Describe the destination, not just the answer

When execution updates a state cell instead of returning an integer in `<k>`,
constrain the updated value there. For example, in a semantics with an `Id`-keyed
map cell, a state fragment might be:

```k
<state> (KEY:Id |-> (N:Int => ?FINAL:Int)) REST:Map </state>
```

This matches the initial entry at `KEY`, rewrites its value, and preserves the
rest of that map. An `ensures` clause must constrain `?FINAL`, not merely repeat
a property of the initial `N`.

A Python function may return through frames and heap objects rather than leave
an `Int` in `<k>`. Inspect the pinned configuration, entry behavior and return
rules to select the real cells and result representation. Specify any required
changes to continuation, instruction pointer, stack and heap; an unchanged cell
pattern also constrains the destination. Framing is not a substitute for stating
the result or other observable effects.

If branches need separate claims, give each a label and guards that collectively
cover the requested domain. Do not exclude a valid branch to make a claim pass.

## Modules, helpers and proof controls

| Notation | Meaning |
|---|---|
| `requires "file.k"` | A file dependency, unlike a claim's Boolean `requires` condition. |
| `module ... endmodule`, `imports M` | Define a module and bring another module's syntax and rules into scope. |
| `rule LHS => RHS` | An equation or transition available to rewriting; it is not a proved theorem. |
| `[function]` | Declares a deterministic helper evaluated by its equations. |
| `[total]` | Declares complete input coverage; the attribute does not establish truth or coverage. |
| `[simplification]` | Makes an equation available to symbolic simplification. Its validity still needs justification. |
| `[circularity]` | Enables self-reuse as an invariant in the supported reachability prover. |
| `[depends(label)]` | Declares reuse of another claim; a previous successful task alone does not install that dependency. |
| `--trusted` | Admits a selected claim without proving it. Record it as an assumption. |
| `--depth` | Bounds execution steps for a diagnostic. Remove it for final positive proof evidence. |

## Read the result while writing

A parser error calls for a syntax, sort or module fix. A residual is a state the
proof did not close: compare its computation and cells with the claimed
destination before choosing a repair. It may show a wrong destination, stuck
execution or an unresolved obligation, not necessarily a counterexample.
`proved` means closure under the submitted theory; it does not justify a helper
rule that assumes the result or establish that the claim matches the request.
