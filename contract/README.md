# Intent Check contract v1

The job API between the `intent` plugin (`nlp-research-rosu/intent-check`) and the prover (`nlp-research-rosu/intent-check-prover`). Both repos carry an identical copy of this folder. `CONTRACT.sha256` holds the hash of every other file here, and a test in each repo fails if they drift.

## Rules

- Changes are **additive only** (new optional fields, new enum values the other side can ignore). Anything else needs `contract_version` "2".
- One commit changes both repos. Run `node contract/hash.mjs --write` afterwards to refresh `CONTRACT.sha256`.
- `job-v1.schema.json` is the source of truth for checks and `deepscan-v1.schema.json` for DeepScan; `types.ts` mirrors it; `constants.json` holds shared limits, header names and the API-key format (the plugin's secret redaction and the prover's key validator both use `api_key.redaction_regex` / `api_key.regex`).

## Endpoints

| Method | Path | Auth | Body → Response |
| --- | --- | --- | --- |
| POST | `/v1/jobs` | Bearer `ic_…` | `JobRequest` → 202 `JobCreated` |
| GET | `/v1/jobs/{job_id}` | Bearer (same account) | → 200 `JobStatus` |
| POST | `/v1/connect` | none (per-IP limited) | `ConnectStart` → 201 `ConnectCreated` |
| GET | `/v1/connect/{device_code}` | none (device_code is the secret) | → 200 `ConnectPoll` |
| GET | `/v1/me` | Bearer `ic_…` | → 200 `Me` |
| DELETE | `/v1/me/key` | Bearer `ic_…` | → 204 (revokes the calling key and its machine, like Revoke on `/account`) |
| POST | `/v1/deepscans` | Bearer `ic_…` | gzip'd `DeepscanUpload` (`application/gzip`, ≤ 16 MB) → 202 `DeepscanCreated`. 404 while the server has DeepScan off |
| GET | `/v1/deepscans/{job_id}` | Bearer (same account) | → 200 `DeepscanStatus` |
| GET | `/r/{job_id}` | none (unlisted) | report page |
| GET | `/og/{job_id}.png` | none | OG card |
| GET | `/connect/{user_code}` | Clerk session | approve page |

`/v1/deepscans` takes the same `Authorization`, `X-Intent-Version` and `Idempotency-Key` headers (a key is never shared between a check and a scan; reusing one across kinds is a 400). Errors add 400 for a bad or over-cap document, 413 above 16 MB compressed or 20 MB inflated, and 429 `rate_limited` / `spend_cap` (with `reason`) from the DeepScan limiters (including `deepscan_ingest_busy`, with a `Retry-After`, when the server is receiving other uploads). A new scan from the same account with the same `remote_url` and `scope` supersedes an unfinished one; a scan without a remote never supersedes.

Request headers on `/v1/jobs`: `X-Intent-Version` (plugin version, 426 below the server minimum), `Idempotency-Key` (stable per logical request: for edit checks a hash of session, turn, paths and file hashes; for queued review requests a hash of the queue item id and file hashes; a repeat returns the original `JobCreated`), optional `X-Intent-Pipeline: llm|canned` (honoured only where the server allows overrides).

Errors are `ErrorResponse` with HTTP 400 `invalid_request`, 401 `unauthorized`, 404 `not_found`, 413 `payload_too_large`, 426 `upgrade_required`, 429 `rate_limited` / `spend_cap` / `blocked` (with `reason`), 500 `internal`.

## Changelog

- 2026-10-08: `DeepscanCard` and `DeepscanOneLiner` gain optional `found_by` (the models whose hunters found the finding) and `jury` (`DeepscanVote[]`: `{model, verdict: "keep"|"drop"}` per juror). Both appear on scans run with two models; a `tiebreak` jury rule adds a third entry that repeats the first reviewer's model.
- 2026-10-08: `DeepscanUpload.depth` (optional `"fast" | "balanced" | "full"`, top level next to `meta`; a missing depth means balanced) added, and echoed as the required `depth` on `DeepscanCreated` and `DeepscanStatus`. `budget_s` now follows the depth (fast 1800, balanced and full 3600).
- 2026-10-08: `DeepscanCreated.budget_s` and `DeepscanStatus.budget_s` (required integer, seconds) added: the wall-clock time the scan may run, so a waiting client sizes its wait from the server's value.
- 2026-10-07: DeepScan added in `deepscan-v1.schema.json` (`POST /v1/deepscans`, `GET /v1/deepscans/{job_id}`, `constants.json` `deepscan` limits). Checks are unchanged; `/v1/jobs/{id}` still answers 404 for a scan id.
- 2026-09-28: `UnitRequest.regions` (optional) added: real line ranges for truncated content.
- 2026-09-30: `Intent.notes` (optional) added: contents of `.intent/NOTES.md`, sent with every job.
- 2026-10-01: `UnitResult.artifacts` gains optional `VERIFICATION.k` and `REASONING.md`; `Prior` gains optional `verification_k`. `SEMANTICS.k` stays required but may be a one-line stub ("Not generated; see REASONING.md") when reasoning is done on paper against `REASONING.md` instead. See "REASONING.md layout" below.
- 2026-10-06: `GET /v1/me` (`Me`) and `DELETE /v1/me/key` added. `ConnectPoll.handle` (optional) added alongside `account.handle`.

## Semantics

- **Supersede.** A new job supersedes the caller's unfinished jobs that overlap it, whatever their mode, unless it carries `per_edit: true`. A `per_edit` job never supersedes anything, so per-edit checks on different files of the same turn all run to completion.
- A superseded job's status becomes `superseded` and it never gets a result. Supersede is account-wide (per caller), not per session.
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

`examples/` holds one file per shape: an edit-mode request, a repo-mode request with 3 units, created, queued, running, done with concerns, done without concerns (its `SEMANTICS.k` is the stub, alongside `VERIFICATION.k` and `REASONING.md`), done partial, superseded, failed, connect created/pending/approved, `me`, and an error. `reasoning.md` and `verification.k` are a standalone worked loop example (not a full job shape) for the `REASONING.md` layout above.
