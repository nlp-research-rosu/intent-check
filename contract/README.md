# Intent Check contract v1

The job API between the `intent` plugin (`nlp-research-rosu/intent-check`) and the prover (`nlp-research-rosu/intent-check-prover`). Both repos carry an identical copy of this folder. `CONTRACT.sha256` holds the hash of every other file here, and a test in each repo fails if they drift.

## Rules

- Changes are **additive only** (new optional fields, new enum values the other side can ignore). Anything else needs `contract_version` "2".
- One commit changes both repos. Run `node contract/hash.mjs --write` afterwards to refresh `CONTRACT.sha256`.
- `job-v1.schema.json` is the source of truth; `types.ts` mirrors it; `constants.json` holds shared limits, header names and the API-key format (the plugin's secret redaction and the prover's key validator both use `api_key.redaction_regex` / `api_key.regex`).

## Endpoints

| Method | Path | Auth | Body → Response |
| --- | --- | --- | --- |
| POST | `/v1/jobs` | Bearer `ic_…` | `JobRequest` → 202 `JobCreated` |
| GET | `/v1/jobs/{job_id}` | Bearer (same account) | → 200 `JobStatus` |
| POST | `/v1/connect` | none (per-IP limited) | `ConnectStart` → 201 `ConnectCreated` |
| GET | `/v1/connect/{device_code}` | none (device_code is the secret) | → 200 `ConnectPoll` |
| GET | `/r/{job_id}` | none (unlisted) | report page |
| GET | `/og/{job_id}.png` | none | OG card |
| GET | `/connect/{user_code}` | Clerk session | approve page |

Request headers on `/v1/jobs`: `X-Intent-Version` (plugin version, 426 below the server minimum), `Idempotency-Key` (stable per logical request: for edit checks a hash of session, turn, paths and file hashes; for queued review requests a hash of the queue item id and file hashes; a repeat returns the original `JobCreated`), optional `X-Intent-Pipeline: llm|canned` (honoured only where the server allows overrides).

Errors are `ErrorResponse` with HTTP 400 `invalid_request`, 401 `unauthorized`, 404 `not_found`, 413 `payload_too_large`, 426 `upgrade_required`, 429 `rate_limited` / `spend_cap` / `blocked` (with `reason`), 500 `internal`.

## Changelog

- 2026-09-28: `UnitRequest.regions` (optional) added: real line ranges for truncated content.
- 2026-09-30: `Intent.notes` (optional) added: contents of `.intent/NOTES.md`, sent with every job.
- 2026-10-01: `UnitResult.artifacts` gains optional `VERIFICATION.k` and `REASONING.md`; `Prior` gains optional `verification_k`. `SEMANTICS.k` stays required but may be a one-line stub ("Not generated; see REASONING.md") when reasoning is done on paper against `REASONING.md` instead. See "REASONING.md layout" below.

## Semantics

- **Supersede:** a new job from the same account for a path supersedes any unfinished job covering that path. The old job's status becomes `superseded` and it never gets a result.
- **Budget:** each job has a time budget (`job_budget_s`). Past it, the job finishes `done` with `partial: true`, stage-A artifacts, claims `not_checked`, verdict `no_concerns`.
- **Agent concerns:** `result.agent_concerns` holds only what the user's agent should hear about (already filtered by the prover). The plugin shows at most `max_agent_concerns_shown`, and builds all agent-facing text itself from these fields.
- **Staleness:** the plugin compares `units[].checked_sha256` with the file's current hash; the prover does not know about later edits.
- **Connect:** the plugin starts a connect request, shows `verification_url`, and polls `GET /v1/connect/{device_code}` every `interval` seconds until `approved` (the key is returned once), `denied`, `expired` or `consumed`.

## REASONING.md layout

`REASONING.md` is the primary evidence for each claim's status: a natural-language
symbolic trace, not a tool's output. It never says or implies that anything was run,
compiled or checked by a tool.

Headings, in order:

- `# Reasoning: <path>` — the checked file's path.
- `## Property` — precondition, postcondition and termination, in plain language.
- `## Execution assumptions` — state representation and source-level transition
  assumptions (what the reasoning takes as given about how the code executes).
- `## Invariant and summary` (omitted when no claim is loop-bearing) — the loop
  invariant, the summary function it relies on, and why they imply the postcondition.
- `## Trace` — one `### Claim [claim-id]` subsection per claim in `SPEC.k`, each with
  a table:

  `| Obligation | Start | Steps | Residual | Status |`

  - `Obligation` is `base`, `inductive` or `whole`: `base` and `inductive` only for a
    loop-invariant claim (one row each); `whole` for an entry claim, or for any
    straight-line claim with no loop (one row).
  - `Start` is the symbolic starting state (cell values and any invariant precondition).
  - `Steps` names the source transitions applied, in order.
  - `Residual` is the condition left after reduction, with substitutions shown.
  - `Status` is `met`, `unmet` or `unknown` — never upgraded to a claim of proof.
- `## Open obligations` — every assumption, missing case or unknown left undischarged.

See `examples/reasoning.md` (with its `VERIFICATION.k` in `examples/verification.k`)
for a worked loop example, and `examples/status-done-no-concerns.json` for how the
artifact sits inside a `UnitResult`.

## Examples

`examples/` holds one file per shape: an edit-mode request, a repo-mode request with 3 units, created, queued, running, done with concerns, done without concerns (its `SEMANTICS.k` is the stub, alongside `VERIFICATION.k` and `REASONING.md`), done partial, superseded, failed, connect created/pending/approved, and an error. `reasoning.md` and `verification.k` are a standalone worked loop example (not a full job shape) for the `REASONING.md` layout above.
