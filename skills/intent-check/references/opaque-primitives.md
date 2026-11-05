# Opaque external primitives

An intentionally external operation can remain uninterpreted while a proof
establishes the surrounding control or data structure. Value-level conclusions
then depend on the operation's named contract. Program-defined code does not
become an external primitive because its proof is difficult.

## Symbolic versus concrete evaluation

A schematic wrapper can leave symbolic calls uninterpreted while computing
ground values where the required arithmetic hook is available:

```k
syntax Float ::= intFloatDiv(Int, Float) [function, total, no-evaluators]
rule intFloatDiv(I, F) => Int2Float(I, 53, 11) /Float F [concrete]
```

| Construct | Effect |
|---|---|
| No applicable equation | The term remains uninterpreted; its numeric value has not been proved. |
| `[concrete]` | Restricts the equation to ground arguments, including ground arguments encountered during a symbolic proof. |
| `[simplification]` with a guard | Permits symbolic unfolding where the guard is established. |
| `[no-evaluators]` | Metadata suppressing a concrete-evaluator coverage warning; it does not disable evaluation. |

A concrete run and a symbolic proof may have different hook support. Ground
arithmetic inside a symbolic proof can therefore fail even when a concrete run
works. A literal such as `-1.0` avoids the evaluation required by
`0.0 -Float 1.0`; it does not prove general float equations.

Threading an opaque term through a map or fold proves structure, not arbitrary
facts about its value. Concrete comparisons supply empirical evidence only.
Replacing program execution needs the separate connection described in
[proof correctness](proof-correctness.md#summarizing-execution-faithfully).
