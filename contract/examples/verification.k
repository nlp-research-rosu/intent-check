// Matches contract/examples/reasoning.md. Defines the one summary function the
// reasoning's claims use: the closed form for 1 + 2 + ... + k.
module SUM-TO-VERIFICATION
  imports INT

  // sumTo(K): the sum 1 + 2 + ... + K for K >= 0; 0 for K < 0 (no terms to add).
  // Guarded and total: every Int has exactly one rule that applies.
  syntax Int ::= sumTo(Int) [function, total]
  rule sumTo(K) => (K *Int (K +Int 1)) /Int 2 requires K >=Int 0
  rule sumTo(K) => 0 requires K <Int 0
endmodule
