# Claim stuck within the first few steps

## Symptom

The residual shows the proof halted almost immediately, before reaching
the program's interesting control, with an elementary operation left
pending. A plain variable lookup that never resolves is the classic sign,
sometimes with a residual constraint like `false #Equals X in_keys(REST)`.

## Mechanism

This is a configuration mismatch, not a hard goal. The claim's cell shapes
do not match what the semantics' rules expect, so no rule applies at all.
A frequent cause is over-generalizing structure: leaving the scope chain,
parent pointers, or map skeleton fully symbolic removes the well-formedness
the lookup rules match on. Generalize the *values* a claim quantifies
over; keep the *structure*, cell skeleton, scope chain, continuation
form, as concrete as the rules require.

## Diagnosis and repair

1. Take a claim of yours that already proves in this definition and diff
   its configuration against the stuck claim's, cell by cell: elided
   cells, scope chain, continuation form. If no claim proves yet, diff
   against the semantics' `configuration` declaration and the cells its
   rules actually match.
2. Align the stuck claim to the proving claim's structure, symbolizing
   only the values the theorem ranges over.
3. Rerun the isolated claim. Do not add lemmas for this symptom, no lemma
   can repair a configuration no rule matches.
