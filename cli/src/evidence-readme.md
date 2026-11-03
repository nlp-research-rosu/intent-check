# .intent

REQUIREMENTS.md is the directly editable project brief, with Purpose, Expected behavior, Constraints, Out of scope and Open questions sections. Structured requirements are managed with intent-check requirements add/update/list/context/remove. JSON and Markdown are separate, not synchronized copies.

Single-source requirements live in files/<source-path>/requirements.json; cross-file requirements live in files/requirements.json. Their schema is schema_version: 1 and requirements. Each record has a stable CLI-assigned REQ-001-style id, statement, nonempty targets (path and optional function/method symbol), and optional reason. Placement follows targets.

Canonical request.json/result.json records live in runs/<run-id>/. DeepScan also saves report.json there; supporting detail files remain remote. Each file review writes files/<source-path>/checks/<run-id>/ with meta.json and only that run's returned INTENT.md, SPEC.k, SEMANTICS.k, VERDICT.md, VERIFICATION.k and REASONING.md artifacts.

Check/DeepScan findings are LLM-reviewed, not formal proofs. Concrete run and validation success are not proof. Source freshness, requirement freshness and evidence level are separate. Every check generation stands alone; partial reviews never borrow artifacts from earlier checks.

Formal bundles live in proofs/<attempt-id>/ with frozen inputs, SCOPE.md, PROOF.md and prove.sh. Results remain in runs/. Supporting inputs are not verified targets; trusted claims are assumptions. prove/sessions/ is ignored authoring scratch, not canonical evidence.

graph.json is the latest local LSP call graph. Its symbols map uses readable file:qualified_name keys and name/file/line/end_line implementation locations. Its calls list records caller/callee/file/line. Lines and inclusive implementation spans are 1-based; repeated names use @line:column (1-based UTF-16 column). Calls sharing caller, callee and source line are combined. Partial graphs also contain status and issues. When language servers are configured globally and Intent Check is enabled, native SessionStart and Stop hooks refresh it after source/config changes. Freshness hashes stay in private global LSP state; diagnostics stay in private plugin logs. It is static context, not proof or a complete inventory of runtime calls, and is not uploaded. Failed refreshes may leave an older snapshot; inspect lsp.finished/lsp.failed in the private plugin log.

Do not edit generated results or frozen inputs. .queue/ is transient file-review scheduling; .sent.log lists upload paths, sizes, times and destinations, never contents. Both are ignored by Git. .ignore keeps generated evidence out of ordinary agent searches.

Durable evidence is intended to be committed. To exclude the whole folder, add .intent/ to the repository's .gitignore. To stop checks use intent-check off, INTENT_DISABLED=1 or DO_NOT_TRACK=1.
