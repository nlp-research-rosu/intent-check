# Reasoning: sum_to.py

```python
def sum_to(n):
    total = 0
    i = 1
    while i <= n:
        total += i
        i += 1
    return total
```

## Property

For an integer `n >= 0`, `sum_to(n)` returns `1 + 2 + ... + n`, i.e. `n*(n+1)/2`,
and the loop terminates: `i` increases by 1 each iteration and the loop exits as
soon as `i > n`, so it runs exactly `n` times. `n < 0` is outside this property;
see Open obligations.

## Execution assumptions

`n` is a parameter, read but never written. `total` and `i` are local variables
initialized before the loop (`total = 0`, `i = 1`) and updated only inside it.
Statements run top to bottom; `total += i` completes before `i += 1` on the same
iteration. Python integers do not overflow, so no range limit applies to `n`,
`total` or `i`.

## Invariant and summary

Summary function (`VERIFICATION.k`): `sumTo(K) = K*(K+1)/2` for `K >= 0`.

Loop invariant, at the loop head with `i |-> I` and `total |-> T` (`n |-> N0`
fixed throughout): `T = sumTo(I-1)`. This says `total` always holds exactly the
sum of the integers already added, `1` through `I-1`. When the invariant holds
and the loop runs to completion, it exits with `i |-> N0+1`, so the invariant at
exit gives `total = sumTo(N0+1-1) = sumTo(N0)`, the claimed postcondition.

Spot check (`N0 = 4`): iterations give `(I, T)` at the loop head as `(1,0) ->
(2,1) -> (3,3) -> (4,6) -> (5,10)`, matching `sumTo(0..4) = 0,1,3,6,10`; the
function returns `10 = sumTo(4)`.

## Trace

### Claim [sum_to-inv]

| Obligation | Start | Steps | Residual | Status |
|---|---|---|---|---|
| base | `i |-> I, total |-> T, n |-> N0`, `T = I*(I-1)/2`, guard `I <= N0` false (`I = N0+1`) | The `while` guard fails, so the loop body runs zero times; `total` and `i` are unchanged. | Substitute `I = N0+1` into `T = I*(I-1)/2`: `T = (N0+1)*N0/2 = sumTo(N0)`, the required final value. | met |
| inductive | `i |-> I, total |-> T, n |-> N0`, `T = I*(I-1)/2`, guard `I <= N0` true | One iteration: `total := T + I` (`total += i`), then `i := I + 1` (`i += 1`); new state `i |-> I+1, total |-> T+I`. | Invariant re-applied at `I' = I+1, T' = T+I` requires `T' = I'*(I'-1)/2 = (I+1)*I/2`. Compute `T + I = I*(I-1)/2 + I = I*(I-1+2)/2 = I*(I+1)/2`. Matches. | met |

### Claim [sum_to-entry]

| Obligation | Start | Steps | Residual | Status |
|---|---|---|---|---|
| whole | `i |-> 1, total |-> 0, n |-> N0`, `N0 >= 0` (the two initializations, before the loop) | Instantiate claim [sum_to-inv] at `I = 1, T = 0`. | Invariant precondition `T = I*(I-1)/2` becomes `0 = 1*0/2 = 0`, which holds; the invariant's conclusion then gives the returned value `sumTo(N0) = N0*(N0+1)/2`, exactly this claim's `ensures`. | met |

## Open obligations

- `n < 0` falls outside the stated property. For `n < 0` the loop guard `i <= n` is false on entry (`i` starts at `1`), so `sum_to` returns `0` without error; this trace does not say whether `0` is the intended result for a negative `n`.
- `sumTo` is defined in `VERIFICATION.k` as the closed form `K*(K+1)/2` rather than by structural recursion over `1 + 2 + ... + K`. The two are assumed equal here; showing it by induction on `K` is straightforward but not carried out in this trace.
- The division `K*(K+1)/2` is exact because `K*(K+1)` is a product of two consecutive integers and so always even; that fact is used but not re-derived here.
