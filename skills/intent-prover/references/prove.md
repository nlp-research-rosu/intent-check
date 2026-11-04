# Prove

Establish the requested formal property over the agreed scope using supported fixed
semantics. K reachability claims establish **partial correctness**: if the precondition
holds and the program terminates, the postcondition holds. Termination needs a
separate argument. A narrower theorem is partial progress, not completion.

## Start and bound the work

Use the global CLI; follow [setup.md](setup.md) only when needed. Read applicable
requirements and selected current specifications. Inspect `intent-prover config`
and `config --help` for run, validation and proof limits. The service owns execution
timeouts; HTTP request timeouts are not task deadlines.

Discover supported IDs with `intent-prover semantics`, inspect sources using
`semantics fetch <id>`, and choose a model matching the program. Start one session:

```sh
intent-prover session start --semantics <id>
intent-prover session show <session-id>
```

Keep its immutable semantics pin and reuse the session for construction and repairs.
Do not edit bundled semantics, substitute a different revision, or invent unsupported
language support. Record a witnessed model gap when the model cannot cover the task.
Do not start a new session to bypass exhausted attempts; an approved limit increase
resumes the existing session. New user feedback re-entering verification starts a
fresh session; explanation-only questions do not.

## Construct and repair

Use [prove-specifications.md](prove-specifications.md) for claims, scope and justified
helpers. Work bottom-up when useful, proving dependencies before their callers, but
do not impose artificial stages. Include the requested entry claims, not only helpers.

Author inputs in the returned `workspaceDir/inputs/`. Read `validate --help` and
`prove --help` for exact paths and controls. Include every transitive local dependency
with repeated `--source` on each submission; imports are not auto-discovered.
Never upload bundled semantics. Validate when parser/module structure is uncertain;
a proof already exercising it does not need duplicate validation. Concrete `run`
checks can resolve specific behavior questions but do not prove symbolic claims.

For a failed attempt, inspect saved stdout residuals, stderr and task state before
retrying. Use [prove-diagnostics.md](prove-diagnostics.md) for the observed mechanism.
Repair and recheck affected claims within the same budget. Difficulty is not a reason
to assume the result or silently narrow the theorem. If tooling, a fixed-model gap,
resources or inconsistent requirements block progress, report the exact unresolved work.

Keep accepted commands running while they poll. If polling disconnects, use
`task show` or `task wait <task-id> --session <session-id>`, not a new submission.
Use `task cancel` when stopping; report anything still running or not confirmed stopped.

## Retain and assess evidence

Use returned paths: `evidenceDir` is `.intent/logs/<run-id>/`; frozen uploaded inputs
are in its `inputs/`; `proofDir` is its `artifacts/`. Never edit frozen inputs.
Place `SCOPE.md`, reproducible `prove.sh` commands and `PROOF.md` in `proofDir`.
Keep authoring scratch separate; deliver exact proved bytes, not later unchecked edits.

Declare source coverage with `--target <path>[::symbol]` and existing local requirement
IDs with `--requirement <id>` where applicable. Those associations are not evidence
that requirements were proved; requirement prose is not uploaded by that flag.
`--spec-id` updates or intentionally shares an existing formal bundle; omitting it
creates an independent bundle even for matching filenames. Current files live in
per-source `specs/<spec-id>/` selected by `index.json`; logs retain operation history.

Before claiming success, apply [prove-evidence.md](prove-evidence.md) to actual files,
assumptions and per-claim results. Same-agent evidence review is required; independent
review or replay is not automatic. Report established scope, conditional conclusions,
finite checks, exclusions and remaining obligations precisely.
