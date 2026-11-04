# Formalize

Read the user's request, applicable `.intent/REQUIREMENTS.md`, structured requirements,
and relevant code, comments and documentation. Separate confirmed behavior from current
implementation and unresolved choices; existing code is not automatically the contract.

## Clarify just enough

Ask small grouped rounds about choices that materially change the current task:
permitted inputs, expected outputs, state changes, failures, boundaries or conflicting
requirements. Explain a concrete consequence and suggest a default when useful.
Use the host's question tool when available. Do not ask the user to repeat retrievable
answers or reopen settled choices. Stop once the task is clear enough; return to
clarification only when a consequential ambiguity emerges.

Prefer the contract's explicit meaning over familiar implementation shortcuts.
Where it is silent, use the reference language's direct idioms and state consequential
readings. Preserve textual distinctions when the contract is textual. If a worked
example contradicts an unambiguous definition, record the discrepancy rather than
narrowing the definition to fit the example; clarify if the intended authority is unclear.

## Record requirements

Keep the project brief in the directly editable `.intent/REQUIREMENTS.md`.
Its initial sections are Purpose, Expected behavior, Constraints, Out of scope and
Open questions. It is separate from structured records, not synchronized with them.
Record confirmed statements; keep unresolved questions visible rather than inventing answers.

For a structured requirement, write transport input outside managed `.intent` paths:

```json
{
  "statement": "Reject negative input prices.",
  "targets": [{"path": "src/pricing.py", "symbol": "calculate_total"}],
  "reason": "Negative prices are invalid."
}
```

```sh
intent-prover requirements add --input requirement-input.json
intent-prover requirements show <id>
intent-prover requirements update <id> --input requirement-input.json
intent-prover requirements list
```

Reuse the returned ID on update. The CLI assigns six-character lowercase letter/digit
IDs and derives placement from targets: one source file uses
`.intent/source/<source-path>/requirements.json`; cross-file records use
`.intent/source/requirements.json`. `symbol` optionally names a function or method,
not a variable. Records accept only `statement`, nonempty `targets` and optional
`reason` as input; do not add assumptions, status, provenance or evidence fields.
Use `requirements --help` for removal and context selection.

Summarize the confirmed behavior and material open questions, then continue the task.
Formalize does not require a formal specification or a service submission.
