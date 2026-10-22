# EVM specification patterns

Use these patterns when the selected semantics is KEVM. Read the session's
pinned sources first; helper names and imports must match that revision.
The pinned semantics defines all supported opcode names; check its syntax
declarations when choosing variable names. Avoid opcode tokens: use
`CALLER_ADDR`, `MSG_VALUE` and `LOGS` rather than `CALLER`, `CALLVALUE` and
`LOG`.

## ABI inputs and outputs

Prefer the typed helpers in the selected `abi.md` for canonical ABI calls:

```k
<callData> #abiCallData("creditOf", #address(OWNER)) </callData>
```

`#abiCallData` takes the function name without a signature, followed by typed
arguments in Solidity parameter order. It generates the four-byte selector
and ABI-encoded arguments. For `sendCredit(address,uint256)`, write:

```k
#abiCallData("sendCredit", #address(TO), #uint256(AMOUNT))
```

Match the declared types and constrain their symbolic values, for example
`#rangeAddress(TO)` and `#rangeUInt(256, AMOUNT)`. For argument encoding alone,
use `#encodeArgs(#address(TO), #uint256(AMOUNT))`; it adds no selector.
For a single unsigned return word, require `#buf(32, VALUE)` in `<output>`.
These helpers are supplied by the selected semantics, not a separate plugin.

Manual bytes are appropriate when testing malformed or noncanonical input.
For canonical calls, reuse the helpers before inventing encoding equations or
adding length and selector assumptions merely to make execution advance.
Canonical encoding alone does not cover every accepted calldata shape. If
the call domain includes trailing bytes, append `+Bytes CD:Bytes` to the
ABI encoding and state any required length bounds. Do not assume the
dispatcher rejects a suffix; inspect its `CALLDATASIZE` and `CALLDATALOAD`
checks.

## Execution state and proof support

Load the KEVM helpers and simplification lemmas in `verification.k`:

```k
requires "edsl.md"
requires "lemmas/lemmas.k"

module VERIFICATION
  imports EDSL
  imports LEMMAS
endmodule
```

If `VERIFICATION` already imports candidate definitions, retain those imports
and add `LEMMAS` there. `requires` loads files; `imports` makes their modules
available. `EDSL` exposes ABI and storage helpers; `LEMMAS` supplies byte,
integer and storage simplifications. Both come from the pinned semantics;
do not upload or duplicate them in the candidate bundle. Use these existing
simplifications before writing replacements. For EVM word arithmetic, avoid
rewriting every `chop(X)` to modulo arithmetic to fix one overflowing sum:
that can obstruct simplification of other additions and subtractions. Match
the residual term and justify the new rule under its word-range conditions.

- For direct runtime entry, set `<program>` to the runtime bytes,
  `<jumpDests>` to their valid jump destinations, `<pc>` to zero,
  `<wordStack>` to `.WordStack`, `<localMem>` to `.Bytes`, and
  `<memoryUsed>` to zero. Match the other cells to the pinned `#execute`
  convention. A residual still containing `#loadProgram` or `#initVM`
  indicates that setup has not executed; inspect those rules before changing
  the return-value claim. Prove one dispatcher-entry claim before reusing
  this initialization. Do not require an empty final `<wordStack>` merely
  because the initial stack is empty.
- Distinguish raw `#execute` from message-call setup and rollback. Starting
  `<pc>` at a function body skips the ABI dispatcher. Successful `SSTORE`
  and `LOG` paths require non-static execution; constrain `<static>` in each
  applicable claim, not just in a separate wrapper claim.
- Align `<schedule>`, `<useGas>`, `<pc>`, `<callValue>`, `<static>` and the
  initial `<log>` with the call domain recorded in `SCOPE.md`. Disabling gas
  excludes gas-consumption and out-of-gas properties; changing the fork can
  change opcode behavior and costs. Distinguish `EVMC_SUCCESS` from
  `EVMC_REVERT` and specify the corresponding return or revert bytes in
  `<output>`.

## Storage and events

- For `SLOAD`, use `#lookup(STORAGE, SLOT)` from the pinned semantics when
  the slot may be absent: EVM storage reads an absent slot as zero. A map
  pattern requiring `SLOT |-> VALUE` excludes that case. Keep unrelated
  storage entries symbolic and unchanged unless execution writes them.
- Model storage writes in execution order, reading later values from the
  updated map after each `SSTORE`. Account for aliased addresses and slots.
  Do not assume distinct slots just to simplify the proof.
- For packed fields, derive the byte offset and extraction from the actual
  storage layout. If an equivalent arithmetic guard leaves opposite branches
  open, compare it with the executed byte-extraction term and align the
  representation without narrowing the input domain.
- Derive event topics, field values and data length from the emitted
  `LOG0`-`LOG4` instruction and its memory slice. Do not assume dynamic event
  data has canonical ABI padding when the compiler emits other bytes.
- Follow modifier and instruction order on failure paths: a guard may fail
  before logging. At raw execution, effects before an exception and effects
  after call-level rollback are different post-states. Match the chosen
  boundary rather than assuming every failure either emits or erases a log.
- Preserve a symbolic initial log prefix when the property permits prior
  events in the same transaction. Starting with an empty log narrows that
  property even if the proof succeeds.
