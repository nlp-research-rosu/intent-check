# Circularity does not apply at the recurring configuration

## Symptom

Symbolic execution returns to what appears to be a loop or recursive control
point, but APR expands another iteration instead of applying the invariant
claim.

## Mechanism

The circularity can be used only when the reached symbolic configuration,
including relevant cell structure and path condition, matches the invariant
claim's left-hand side strongly enough for the claim to apply. Source-level
similarity is insufficient: different head symbols, argument order, frames,
cells, or constraints can prevent the match.

For example, a reached term

```k
repeatUntil(Done, Body) ~> KREST
```

does not match a claim beginning with

```k
loop(Body, Done) ~> KREST
```

even if both constructs were intended to describe the same loop.

## Diagnosis and repair

1. Check the claim reuse attributes in
   [writing-spec](../writing-spec/SKILL.md#claim-structure-and-reuse).
2. Isolate the invariant claim and use
   [bounded inspection](../proving-spec/SKILL.md#symptom-router-and-bounded-inspection).
3. Compare the complete reached configuration with the claim's left-hand side.
4. If the reached term is the intended recurring representation, rewrite the
   claim to describe that exact configuration.
5. If the semantics was intended to reconstruct a different recurring term,
   fix that semantics rule and rerun its concrete smoke tests.
6. Rebuild and rerun the invariant claim before attempting the whole program.

Do not replace a language's loop with an unrelated example encoding merely to
copy a passing proof. The invariant and the actual recurring configuration must
agree.
