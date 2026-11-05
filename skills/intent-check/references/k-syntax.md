# K syntax and operational semantics

Use this reference to read the pinned language's configuration, grammar and
rewrite rules while constructing a spec. These examples explain K notation;
do not replace the downloaded semantics with a new configuration or rules.

## Configuration and cells

A K configuration is the complete state rewritten by the semantics:

```k
configuration <T>
                <k> $PGM:Stmt </k>
                <state> .Map </state>
              </T>
```

The `<k>` cell holds the current computation. Additional cells hold only the
state the semantics models, such as variable bindings, a heap, or output.

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

When a program stops with an unmatched term at the front of `<k>`, inspect
the pinned rules and side conditions. A malformed entry state or unsupported
construct may be responsible; do not patch the language semantics to close a claim.
