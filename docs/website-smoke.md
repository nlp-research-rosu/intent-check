# Website Scan and Prove smoke

`website-smoke.yml` runs only for same-repository `staging` → `main` pull
requests (opened, updated or reopened). It does not run on feature PRs, pushes,
releases or manual dispatch. Existing unit and mock-host checks are unchanged.

## Credentials

In this repository's **Settings → Secrets and variables → Actions**, add:

- `OPENROUTER_API_KEY`: a dedicated spend-limited OpenRouter test key, **Prove only**.
- `INTENT_STAGING_API_KEY`: a separate, approved staging test account's key.

Missing required secrets fail before remote work. Never use a production key.
Use a dedicated account so its work and usage can be attributed to testing.
Keys are supplied only to the corresponding smoke step, not installation or
builds. Scan receives only `INTENT_STAGING_API_KEY`; it does not install Pi,
require OpenRouter credentials, load skills or invoke an outer model.

## What runs

The workflow tests GitHub's PR merge commit, recording its base/head/merge SHAs.
It generates a staging package in a disposable checkout using
`scripts/package-channel.mjs`, then builds and installs its native CLI. The
local `<source-version>-staging.0` identity is only for this unpublished test:
no tag, release, catalog or source-version update is made.

For Prove, Pi `1.5.2` on Node `22.19.0` uses OpenRouter's
`openai/gpt-6-luna` with `high` thinking. These pins, the 1,500-second
withdrawal deadline and 2,400-second Scan deadline are visible in the workflow.
The cases run sequentially in separate isolated jobs; failure does not skip the
other case. The isolated CLI permits five proof attempts, five validations and
ten concrete runs in one construction session.
There is no whole-scenario retry or model fallback. Normal proof repairs happen
inside that session. Model-provider routing follows the test key's OpenRouter
settings; freeze those restrictions for comparisons.

`test/smoke/withdraw.txt` and `test/smoke/mle-bench.txt` are the public Prove and
default Scan requests retrieved from <https://prover.intentcomputing.org/> on
2026-11-11. Their original “Intent Check” wording is intentional; update it
explicitly when the published prompts change.
The Prove harness separately explains that this is internal staging testing and
that the generated staging skill/CLI must be used. It supplies no solved claims
or implementation. The effective Prove inputs and both website prompt hashes
are retained. The Scan prompt is a source reference, not sent to an agent.

Scan orchestration is deterministic: the harness fetches `openai/mle-bench` at
`507f92e1138bb6e40dac5c6ee7a6758e6424bf97` into a fresh isolated checkout and
invokes the existing generated staging launcher directly for one `fast` Scan of
`mlebench/competitions/jigsaw-unintended-bias-in-toxicity-classification/`.
The invocation is `node <staging-package>/bin/intent.js scan <folder> fast`,
not a new API client or the native Prove command. The upload scope and exact
checkout/launcher commands are saved alongside the reference website prompt.
The launcher submits, polls, downloads the report and saves local evidence.
The harness never resubmits; interrupted/failed runs fail and cleanup cancels
recorded unfinished tasks. The existing `scan collect <task-id>` command remains
the recovery path, not a replacement submission. The 40-minute outer deadline
covers checkout and the launcher around the service's 30-minute fast budget;
queue delays can still fail the smoke. No repository dependencies or scripts
are installed/run. The backend Scan still uses its configured model: only the
outer orchestration is deterministic. This covers the Scan client/service
path, not natural-language prompt interpretation or skill selection.

For Prove, Pi loads the complete generated staging skill and its relative
references. Pi has ordinary read/write/edit/bash tools; no custom agent loop or extension is
used. K execution stays on the staging VPS, not the GitHub runner. The test does
not cover Claude Code/Codex marketplace installation or production packaging.

## Results and limitations

The final proof must have authoritative service state `completed` / `proved`,
no task error, matching session semantics and a successful final tool exit when
tools ran. A cached proof is accepted and labelled `reused`; it does not test a
fresh proof-worker execution. The agent must retain `PROOF.md` and `SCOPE.md`.

Scan requires exactly one saved submission, with authoritative task kind `scan`,
status `completed`, no error and depth `fast`. The saved staging record must show
successful report collection and the requested repo/revision/scope. Source-file
manifest hashes must match both the pinned Git objects and unchanged working
files; tracked changes and non-ignored untracked files outside `.intent/` fail.
The saved report's bytes/hash must match the service artifact reference. Its JSON
must contain an integer version, coverage object and finding arrays; summary
counts must be nonnegative integers. Findings must have titles, valid severities
and in-range locations in submitted source files. Zero findings are allowed.
These checks validate evidence structure, **not** finding correctness or the
completeness of the grader/scoring-rules investigation. Review report coverage,
limitations and support for findings after the first live trial.

This is a workflow smoke, **not an automatic audit of generated mathematics**.
Review the first trial's claims, actual program correspondence, all three
requested properties, assumptions and any trusted claims before calling the
website example verified. A green service result alone does not establish that
the agent proved the intended theorem. There is no second-model judge.

Each artifact retains selected proof sources/results or Scan report/metadata,
authoritative task states, effective inputs/Scan plan and metrics for seven days.
It excludes credential homes and raw Pi transcripts; injected key values are
redacted from retained text. Prove's Pi cost is an estimate, not actual billed
cost; reconcile it with OpenRouter usage for the cost trial. VPS service compute
is separate and is not capped by the OpenRouter key. Scan records no outer-model
usage or cost; it does not measure backend model billing. The workflow records
runtime including client preflight, but does not independently measure
queue/worker time beyond saved service evidence.

On deadline or interruption the harness stops the active Pi/checkout/launcher
process and requests cancellation of proof and Scan tasks recorded by this run.
Cleanup failures fail the smoke and retain task IDs for investigation. A runner
crash or a lost submission response can leave a job without local evidence;
the VPS's own execution deadlines remain necessary.
Concurrency does not interrupt an active run when the PR receives another push.

No paid run is needed to check the harness itself. Node syntax, existing unit
checks, packaging/native build and controlled local Pi/CLI doubles can verify
wiring; these are not substitutes for the authorized live staging trial.
