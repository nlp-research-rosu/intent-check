# Spec authoring

A specification relates allowed initial states to required final states. Its
meaning includes both the claims in `spec.k` and any mathematical summaries in
`verification.k`. [K notation and examples](k-glossary.md) show the file structure.

## From property to configuration

| Property component | K representation |
|---|---|
| Inputs and domain | Symbolic values in the initial cells; `requires` expresses their constraints. |
| Program invocation | The actual entry computation and runtime state from the pinned semantics. |
| Result and state changes | Destination cell patterns and `ensures` over final values. |
| Alternative behavior | Separately labelled claims whose guards collectively cover the domain. |
| Unobserved state | Frames or variables consistent with the property and execution. |

The result is wherever the language semantics puts it: a heap object, return
frame, stack value or output cell, not necessarily an `Int` in `<k>`. A cell
without `=>` constrains both endpoints. Pinning an initial instruction pointer,
stack or continuation on the destination can make a correct execution unprovable.

An existential final value needs a relationship to the actual result; repeating
a property of an unchanged input does not constrain the output. Preconditions
must be realizable and cover the agreed inputs. [Contract interpretation](reading-the-contract.md)
addresses ambiguous requirements; [correctness](proof-correctness.md) explains
domain and language-model boundaries.

## Claim structure and reuse

Stable labels identify claims and their dependencies. `[circularity]` enables
self-reuse as an invariant; `[depends(label)]` declares another claim's use.
A successful earlier task does not install that claim as a rewrite rule.
`--trusted` admits a claim without proof and makes dependent conclusions conditional.

For loops, a claim over an arbitrary intermediate state generalizes the entry
claim; see [invariants](deriving-invariants.md). For calls, auxiliary claims must
match the actual invocation and return context. A proved helper alone does not
establish its caller.

Definitional summaries live in `VERIFICATION-SUMMARIES`; proof-support equations
live in `VERIFICATION`. Ordinary helper rules belong in `verification.k`, not
the spec module. Changing a summary's meaning changes the theorem. See
[K claims](k-claims.md) for modules, equations and attributes.

## Plain-language scope

`SCOPE.md` explains what the formal statement means before submission. Its first
section after the title is `## Property in plain language`: permitted inputs,
required result/state changes, assumptions and exclusions, without K jargon.
Describe the claims actually submitted, including the lack of a termination
proof when only partial correctness is established.

```markdown
# Verification scope

## Property in plain language

For every nonnegative integer input, if the program finishes, its result is
the sum of the integers from 1 through the input. Termination is not proved.

## Program boundary

Entry point, input representation, observed state and semantics revision.
```
