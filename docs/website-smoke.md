# Website proof smoke

`website-smoke.yml` runs only for same-repository `staging` → `main` pull
requests (opened, updated or reopened). It does not run on feature PRs, pushes,
releases or manual dispatch. Existing unit and mock-host checks are unchanged.

## Credentials

In this repository's **Settings → Secrets and variables → Actions**, add:

- `OPENROUTER_API_KEY`: a dedicated test key with an OpenRouter spending limit.
- `INTENT_STAGING_API_KEY`: a separate, approved staging test account's key.

Missing secrets fail the smoke before any model call. Never use a production
key. Use a dedicated account so its proof work and usage can be attributed to
testing. Keys are supplied only to the smoke step, not installation or builds.

## What runs

The workflow tests GitHub's PR merge commit, recording its base/head/merge SHAs.
It generates a staging package in a disposable checkout using
`scripts/package-channel.mjs`, then builds and installs its native CLI. The
local `<source-version>-staging.0` identity is only for this unpublished test:
no tag, release, catalog or source-version update is made.

Pi `1.5.2` on Node `22.19.0` uses OpenRouter's
`anthropic/claude-haiku-5.5` with `medium` thinking. These pins and the 1,500-second
agent deadline are visible in the workflow. The isolated CLI permits five proof
attempts, five validations and ten concrete runs in one construction session.
There is no whole-scenario retry or model fallback. Normal proof repairs happen
inside that session. Model-provider routing follows the test key's OpenRouter
settings; freeze those restrictions for comparisons.

`test/smoke/withdraw.txt` is the public Prove request retrieved from
<https://prover.intentcomputing.org/> on 2026-11-11. Its original “Intent Check”
wording is intentional; update it explicitly when the published prompt changes.
The harness separately explains that this is internal staging testing and that
the generated staging skill/CLI must be used. It supplies no solved claims or
implementation. Both effective inputs and the prompt hash are retained.

Pi loads the complete generated staging skill and its relative references. Pi
has ordinary read/write/edit/bash tools; no custom agent loop or extension is
used. K execution stays on the staging VPS, not the GitHub runner. The test does
not cover Claude Code/Codex marketplace installation, production packaging, or
Scan (which still uses the Node launcher rather than the native Prove CLI).

## Results and limitations

The final proof must have authoritative service state `completed` / `proved`,
no task error, matching session semantics and a successful final tool exit when
tools ran. A cached proof is accepted and labelled `reused`; it does not test a
fresh proof-worker execution. The agent must retain `PROOF.md` and `SCOPE.md`.

This is a workflow smoke, **not an automatic audit of generated mathematics**.
Review the first trial's claims, actual program correspondence, all three
requested properties, assumptions and any trusted claims before calling the
website example verified. A green service result alone does not establish that
the agent proved the intended theorem. There is no second-model judge.

The artifact retains selected proof sources/results, authoritative task states,
effective inputs and metrics for seven days. It excludes credential homes and
raw Pi transcripts; the two injected key values are redacted from retained text.
Pi's cost is an estimate, not actual billed cost; reconcile it with OpenRouter
usage for the cost trial. VPS proof compute is separate and is not capped by the
OpenRouter key. The workflow records runtime including client preflight, but
does not independently measure queue/worker time beyond saved service evidence.

On deadline or interruption the harness stops Pi and requests cancellation of
tasks recorded by this run. Cleanup failures fail the smoke and retain task IDs
for investigation. A runner crash or a lost submission response can leave a job
without local evidence; the VPS's own execution deadlines remain necessary.
Concurrency does not interrupt an active run when the PR receives another push.

No paid run is needed to check the harness itself. Node syntax, existing unit
checks, packaging/native build and controlled local Pi/CLI doubles can verify
wiring; these are not substitutes for the authorized live staging trial.
