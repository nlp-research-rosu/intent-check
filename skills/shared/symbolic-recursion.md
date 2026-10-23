# Symbolic helper keeps unfolding

## Symptom

A helper term grows at successive proof depths and never reaches a base case.
The same helper may terminate normally for concrete inputs.

## Mechanism

A recursive equation can keep firing when its argument is symbolic and the path
condition continues to entail the recursive guard. Unlike a concrete call, the
proof does not necessarily reach a smaller ground value, so repeated unfolding
does not establish progress.

## Diagnosis and repair

1. Use
   [bounded inspection](../proving-spec/SKILL.md#symptom-router-and-bounded-inspection)
   and confirm that the growing subterm is the helper rather than the
   program control term.
2. Identify the guard that remains applicable and the symbolic argument that
   fails to reach a base case.
3. When an equivalent closed form exists and the target solver can decide its
   theory, prefer that form.
4. If no faithful closed form exists, keep the recursive definition. Expose its
   base and step behavior through justified induction, folding, or summary
   lemmas, oriented so they fold proof states toward the summary term instead
   of expanding a symbolic call without bound.
5. Abstract the operation behind a trusted opaque symbol only when that trust
   boundary is intentional, and validate its concrete behavior independently.
6. Rerun the isolated obligation before returning to the full claim.

A closed form is not automatically solver-friendly, and recursion is not
automatically wrong. The proof needs a faithful definition plus equations or
lemmas that make progress in the backend's supported theories.
