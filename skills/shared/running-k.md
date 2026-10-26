# Running K through Intent Check

Use this reference to choose live K operations and apply prove mode's evidence and
workflow rules. Detailed CLI usage lives in the executable's help.

## Shell setup

Live verification requires the global `intent-check` CLI and a reachable Intent Check service.
Locate the executable on `PATH`. If it is missing or Intent Check needs first-time
setup, use [onboarding](../onboarding/SKILL.md). Otherwise proceed with
the requested operation using the saved key. For authentication or
permission errors, sign in with `intent-check login`
([proof-help](../proof-help/SKILL.md#connection)).

## CLI contract

`intent-check` is the only live K client. For command usage, configuration
and resource limits, follow [proof-help](../proof-help/SKILL.md). Use its command
reference for `health` and `semantics` during setup. Use the CLI's structured
results for workflow decisions.

## Semantics descriptor

Discover available IDs and capabilities with `intent-check semantics`;
the server registry is authoritative. Start a session for the selected
language ID before live construction. Read
its help for project selection, shared source locations, and audit sessions.
The CLI owns the global `session.json`. Inspect its semantics ID and pinned
revision with `intent-check session show`. Use `intent-check semantics fetch`
to locate
the shared reference sources. Create `workspaceDir/inputs/` for session input
files: `spec.k`, `verification.k`, local dependencies, and concrete test
programs.
Keep reports, scripts, and operation results outside `inputs/`; the original
program stays in the project. Your own files (`spec.k`, `verification.k`,
`SCOPE.md`, `prove.sh`, `PROOF.md`) go in `.intent/prove/<target>/` relative to
the session's `projectRoot`, which is detected automatically as the repository
root, not the shell's working directory. Outside a repository it is the session's
project directory. Pass the session ID to each live command; command
help defines input paths. `intent-check run --program` takes a path relative to
the
session's project directory, not an absolute path.

For a clean-room replay, start another session for the same semantics ID and
confirm its semantics ID and commit match the construction session. A changed
server revision blocks that replay; do not silently audit different semantics.
Never manually replace the pin, edit downloaded sources, or upload bundled
semantics. If no
supported revision models the program language, the live pipeline is BLOCKED.

## Backends

The Intent Check service owns backend selection and definition reuse. For module or definition
mismatches, inspect the selected registry entry and submitted proof sources;
use the semantics and proof command help for diagnostic controls.

## Proof submission

Use validation when source structure needs checking before proof; a proof
task already exercising the same structure need not repeat it. A successful
validation is not proof or non-vacuity evidence. For a failed proof, read
the retained evidence, repair the K artifacts, and submit in the same
construction session.
Never use a prior task result as evidence for edited sources.

PyK APR accepts both `--depth` and `--trusted`. A trusted claim is
admitted without proof and is available to callers only through
`[depends(...)]`. A depth bound limits rewrite steps along each execution
path; a failing or bounded leaf yields `notProved`.
Remove `--depth` for the final positive proof.

Record assumed claims in the trust ledger under the
[soundness contract](proof-extension-soundness.md); command help explains how
to select claims and declare assumptions.

## Reading the result

Require `task.status` of `completed`, `task.result` of `proved`, and no
`task.error`. If tools ran, also require the final tool exit code to be 0.
The Intent Check service may reuse a result with `toolRuns: []`; no new tool exit code exists
in that case. Then inspect the submitted claim selection and the selected backend's
per-claim evidence in saved stdout. Check which claims were admitted with
`--trusted`.
An admitted claim is an assumption, not a proved claim. Closure under the
supplied theory remains insufficient for validation; follow the proof audit
for soundness, adequacy, and non-vacuity.

The CLI saves the server's `/tasks/{id}/stdout` response as `stdout` in
`proof-NNN/result.json`. PyK APR prints each claim's summary, pending node
IDs, and failing nodes' reasons and path conditions, including after a
timeout. Other backends emit their residual as KAST in stdout; parse it
without a recursion limit. Unproved states are not necessarily
counterexamples. Read stderr and the task result alongside stdout.

An internal exception from a prove task that validated cleanly is a failed
proof whose residual could not be printed, not a syntax problem. Do not bisect
the sources; check the claims' boundary cases and inspect a focused claim.

For a deliberate false postcondition, require `notProved` plus stdout evidence
showing the unmet condition. An error or timeout is not mutation
evidence. Account for every accepted submission: stopping the local process
does not by itself prove that its server task stopped.

## Diagnostic entry points

- Validate to separate source or module failures from proof behavior.
- Isolate claims and inspect bounded residuals when a proof stalls; see
  [bounded inspection](../proving-spec/SKILL.md#symptom-router-and-bounded-inspection).
- For task timeouts, follow [proof-help](../proof-help/SKILL.md#task-timeouts).

## Recording prove.sh

`prove.sh` is executable evidence, not a summary. It must call the global
`intent-check` CLI with the same session and controls used for the final run.
Retain
the associated task evidence. Never start a new session automatically inside
the script to bypass an attempt limit. Never reduce it to a process exit check,
and never use a depth bound in its final positive proof.
