# K syntax and operational semantics

Use this reference while defining a language's configuration, grammar, and
rewrite rules.

## Configuration and cells

A K configuration is the complete state rewritten by the semantics:

```k
configuration <T>
                <k> $PGM:Stmt </k>
                <state> .Map </state>
              </T>
```

The `<k>` cell holds the current computation. Additional cells hold only the
state the modeled constructs need, such as variable bindings, a heap, or output.

## Grammar

User syntax is declared with `syntax` productions. Group operators of equal
precedence under one associativity group:

```k
syntax AExp ::= Int | Id
              | "(" AExp ")" [bracket]
              > left:
                AExp "+" AExp [seqstrict]
              | AExp "-" AExp [seqstrict]
```

Associativity applies to the group, not independently to each production.
Putting `[left]` on `+` and `-` separately leaves mixed input such as
`a + b - c` ambiguous. Keep a `[bracket]` production when parentheses are part
of the source language.

Concrete program identifiers used inside claims must parse as identifiers:

```k
syntax Id ::= "n" [token]
            | "s" [token]
```

Without those token productions, names such as `n` in a claim can be parsed as
K rule variables rather than as keys in the modeled program state.

## Rules and rewriting

Rules define one operational step:

```k
rule <k> X:Id = I:Int ; => .K ...</k>
     <state> STATE => STATE [ X <- I ] </state>
```

- `=>` rewrites the matched content.
- `.K` is the empty computation.
- `...` frames the rest of a cell.
- `strict` and `seqstrict` generate evaluation order for subterms.
- `KResult` identifies fully evaluated values.

When a program stops with an unmatched term at the front of `<k>`, the
semantics is missing a rule for that term or a required side condition did not
hold. Treat the residual term as a diagnostic; do not add unrelated rules.
