# Minimal stateful semantics template

Use this template only when no reusable semantics exists. Adapt it to the
construct inventory; remove productions and rules the target programs do not
use.

```k
module SEMANTICS-SYNTAX
  imports DOMAINS-SYNTAX

  syntax AExp ::= Int | Id
                | "(" AExp ")" [bracket]
                > left:
                  AExp "+" AExp [seqstrict]
                | AExp "-" AExp [seqstrict]
  syntax BExp ::= Bool | AExp ">" AExp [seqstrict]
  syntax Block ::= "{" "}" | "{" Stmt "}"
  syntax Stmt ::= Block
                | Id "=" AExp ";"                      [strict(2)]
                | "if" "(" BExp ")" Block "else" Block [strict(1)]
                | "while" "(" BExp ")" Block
                > Stmt Stmt [left]

  syntax Id ::= "n" [token]
              | "s" [token]
  syntax KResult ::= Int | Bool
endmodule

module SEMANTICS
  imports SEMANTICS-SYNTAX
  imports INT
  imports BOOL
  imports MAP

  configuration <T>
                  <k> $PGM:Stmt </k>
                  <state> .Map </state>
                </T>

  rule <k> X:Id => I ...</k>
       <state>... X |-> I ...</state>
  rule <k> I1 + I2 => I1 +Int I2 ...</k>
  rule <k> I1 - I2 => I1 -Int I2 ...</k>
  rule <k> I1:Int > I2:Int => I1 >Int I2 ...</k>
  rule <k> X:Id = I:Int ; => .K ...</k>
       <state> S => S [ X <- I ] </state>
  rule <k> S1:Stmt S2:Stmt => S1 ~> S2 ...</k>
  rule <k> {} => .K ...</k>
  rule <k> { S } => S ...</k>
  rule <k> if (true)  S:Block else _ => S ...</k>
  rule <k> if (false) _ else S:Block => S ...</k>
  rule <k> while (B:BExp) S:Block
        => if (B) { S while (B) S } else {} ...</k>
endmodule
```

This is one complete example, not a universal language design. In particular,
the loop rule is suitable for this syntax because it reconstructs the same
`while` term after one body step. Other languages may use a different recurring
term; any invariant claim must match the configuration their semantics actually
reaches.
