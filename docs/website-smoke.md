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
`deepseek/deepseek-v4.1-flash-1017` with `high` thinking. Neither Prove nor Scan has a
harness-imposed overall timeout or a custom workflow job timeout.
The cases run sequentially in separate isolated jobs; failure does not skip the
other case. The isolated CLI permits 50 proof attempts, 50 validations and
50 concrete runs in one construction session.
There is no whole-scenario retry or model fallback. Normal proof repairs happen
inside that session. Pi's isolated model configuration explicitly requires
OpenRouter zero data retention (`zdr: true`), no data collection
(`data_collection: "deny"`) and support for the requested parameters. OpenRouter
may fall back between privacy-compatible providers for this same model; no
first-party provider or precision is guaranteed. Account/key restrictions still
apply and are not relaxed by the harness. Provider prices vary; reconcile actual
OpenRouter billing rather than assuming first-party rates. The per-response output
ceiling is 393,216 tokens, also constrained by remaining model context. This is
not a conversation-turn limit. The effective model configuration is retained.

`test/smoke/withdraw.txt` and `test/smoke/mle-bench.txt` are the public Prove and
default Scan requests retrieved from <https://prover.intentcomputing.org/> on
2026-11-11. Their original “Intent Check” wording is intentional; update it
explicitly when the published prompts change.
The Prove harness separately explains that this is internal staging testing and
that the generated staging skill/CLI must be used. It supplies the unchanged
Python function and pre-generated matching bytecode, but no solved claims or
specification. The effective Prove inputs and both website prompt hashes
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
the recovery path, not a replacement submission. The harness waits for the
launcher without a wall-clock cutoff. No repository dependencies or scripts
are installed/run. The backend Scan still uses its configured model: only the
outer orchestration is deterministic. This covers the Scan client/service
path, not natural-language prompt interpretation or skill selection.

For Prove, Pi loads the complete generated staging skill and its relative
references. Pi has ordinary read/write/edit/bash tools; no custom agent loop or extension is
used. K execution stays on the staging VPS, not the GitHub runner. The test does
not cover Claude Code/Codex marketplace installation or production packaging.

The agent starts with `withdraw.py` and `withdraw.kpyc` from
`test/smoke/withdraw/`, pinned to `python-3-14-6@e5d24a5429a4`. This tests skill,
specification construction and CLI use, not interpreter installation. The
harness checks the source against the unchanged website prompt and the two
fixture hashes, retains both inputs, and requires the proof session to use the
matching semantics pin. The agent must construct the claims itself.

To regenerate the bytecode, use CPython **3.14.6** and the unmodified exporter
downloaded by `intent-prover-staging semantics fetch python-3-14-6`. Confirm the
returned commit matches `fixture.json`. From `test/smoke/withdraw/`, with
`PYTHONPATH` set to that reference source directory, run:

```sh
python3.14 -B -m exporter withdraw.py --check --pretty
```

Update the fixture hashes only alongside an intentional input or pin change.
The exporter checks passed and repeated generation produced identical bytes.
No matching Python interpreter or exporter execution is needed during CI.

## Results and limitations

Both smoke jobs are **advisory**, with `continue-on-error`; their outcomes do not
gate merging. Their artifacts retain actual failures instead of rewriting them
as proof success. A separate reporting job updates one bot comment on the
promotion PR with service outcomes, Scan findings/coverage, agent proof scope,
runtime, estimated model cost and links to evidence/offline HTML. Missing
results and setup failures are labelled blocked. Evidence lasts seven days.
Only this separate job receives permission to write PR comments; the agent and
Scan jobs receive no GitHub token or write permission. Reporting failures are
also non-blocking and remain visible in the workflow logs.

The final proof must have authoritative service state `completed` / `proved`,
no task error, matching session semantics and a successful final tool exit when
tools ran. A cached proof is accepted and labelled `reused`; it does not test a
fresh proof-worker execution. The agent must retain `PROOF.md` and `SCOPE.md`.

Scan requires exactly one saved submission, with authoritative task kind `scan`,
status `completed`, no error and depth `fast`. The saved staging record must show
successful report collection and the requested repo/revision/scope. Source-file
manifest hashes must match the pinned Git blobs (or a Git LFS pointer's SHA-256
and byte size) and unchanged working files; tracked changes and non-ignored
untracked files outside `.intent/` fail.
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

On explicit interruption the harness stops the active Pi/checkout/launcher
process and requests cancellation of proof and Scan tasks recorded by this run.
Cleanup failures fail the smoke and retain task IDs for investigation. A runner
crash or a lost submission response can leave a job without local evidence.
GitHub-hosted jobs still have GitHub's default six-hour execution limit; this
workflow does not impose a shorter one. Individual HTTP request limits and the
service's own execution policies are unchanged; they are not smoke deadlines.
Concurrency does not interrupt an active run when the PR receives another push.

No paid run is needed to check the harness itself. Node syntax, existing unit
checks, packaging/native build and controlled local Pi/CLI doubles can verify
wiring; these are not substitutes for the authorized live staging trial.
