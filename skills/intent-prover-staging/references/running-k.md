# Running K through Intent Prover Staging

Use this for input preparation, proof controls and results. Exact command syntax:
`intent-prover-staging <command> --help`. For connection, limits and recovery, see [CLI help](proof-help.md).

## Shell setup

Use the global `intent-prover-staging` CLI on `PATH`; the service executes K remotely.
Use [onboarding](onboarding.md) for missing setup and `health` for reachability.

## CLI contract

The CLI submits inputs, polls tasks and saves evidence. The service selects the
backend, prepares/reuses compiled definitions and enforces execution limits.
Use structured results, not process exit alone, to decide what happened.

## Semantics descriptor

- `semantics` lists supported IDs and capabilities. `session start` pins a revision
  and downloads its sources; `session show` reports the pin and workspace.
  `semantics fetch` locates cached sources: check they match the session pin.
- Pass the session ID to every live operation. The CLI owns `session.json`;
  do not replace its pin, edit downloaded semantics or upload bundled semantics.
  An unsupported language feature blocks that scope.
- Put submitted specs, helpers, dependencies and concrete test programs in
  `workspaceDir/inputs/`; keep reports, scripts and results outside it.
  Keep deliverables in `.intent/prove/<target>/` under the returned `projectRoot`.
  The original source stays in the project.
- Paths follow command help. `run --program` is relative to the session's project
  directory, not absolute. `projectRoot` is the detected repository root, or the
  selected project directory outside Git.
- Reproducing a proof requires the same semantics ID and commit as its evidence.

## Language tools

Fetching semantics does not install a language interpreter/compiler. Check the
definition's input requirements. Python bytecode needs its pinned exporter and
matching CPython version. Report missing tools; do not substitute another pin
or hand-author bytecode.

## Proof submission

| Operation/control | Meaning and use |
|---|---|
| `validate` | Checks source/module structure, not truth or satisfiable inputs. Use for structure errors; skip duplicate validation when proof already checks the same sources. |
| `prove` | Attempts the selected claims. Inspect saved evidence, repair identified defects and retry in the same session. Edited inputs need new evidence. |
| `--depth` | Caps rewrite steps per execution path. Unclosed bounded or failing leaves yield `notProved`. Use for diagnosis; omit from the final positive proof. |
| `--trusted` | Admits selected claims without proving them; callers use `[depends(label)]`. Record admitted claims as assumptions and dependent proofs as conditional on them. |

Check supported controls and claim selection in `prove --help` and session
capabilities. Added theory needs [independent justification](proof-correctness.md#definitions-lemmas-and-assumptions).

## Reading the result

- Success requires `task.status: completed`, `task.result: proved`, no `task.error`,
  and final tool exit 0 when tools ran. `toolRuns: []` can mean a reused result;
  there is no new exit code to check.
- Read `stdout`, stderr and task fields in `proof-NNN/result.json`. Check selected
  claims, admitted claims, pending/failing nodes, reasons and path conditions.
  Residual states may be text or KAST; use a parser that handles their nesting.
- `notProved` means obligations remain, not necessarily a counterexample. A
  timeout or internal exception does not establish a false claim.
- Tool success establishes closure under the submitted theory, not its
  [faithfulness to the program and property](proof-correctness.md).
- For a false-postcondition diagnostic, require `notProved` and evidence of the
  unmet condition; parser errors and timeouts do not count.

## Task error codes

A `failed` or `timed_out` task carries `task.error.code`; act on the code, not
on `task.error.message`, which is fixed text that can change.

| Code | Next step |
|---|---|
| `INVALID_INPUT` | Fix the input. K's message is in stderr; `details.path` names the source at fault. With `details.supported`, resubmit on that semantics revision. |
| `PROOF_UNDECIDED` | The solver could not decide an obligation: no counterexample. Split the claim or add lemmas. |
| `PROVER_BACKEND_FAILED` | The backend failed internally. Change the proof before resubmitting; report the task ID if it persists. |
| `TIMED_OUT` | The service limit ended the work; `details.tool` names the tool. Narrow the program or claim. |
| `TASK_FILE_MISSING` | A stored input is gone. Submit again. |
| `SERVICE_UNAVAILABLE` | A service the prover depends on failed. Try again later. |
| `INTERNAL_ERROR` or unknown | The service already retried. Do not loop; report the task ID to the user. |

`details.attempts` counts the attempts when the service retried.

## Diagnostic entry points

- Source/module error: inspect submitted files and the selected semantics entry;
  use `validate` to isolate structural issues.
- Unclosed claim: compare residual and destination; see [proof debugging](proof-debugging.md).
- Internal exception after successful validation: inspect stderr and a focused
  claim's boundary cases; do not assume the exception is a syntax error.
- Timeout/interrupted wait: follow [task recovery](proof-help.md#task-timeouts).

## Recording prove.sh

Record the actual global CLI commands, session and controls used; retain their
task evidence. No automatic replacement session, exit-code-only success check,
or `--depth` in the final positive proof.
