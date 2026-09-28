# Plugin agent status

Milestone: M2a (Claude Code plugin core). Stacked PRs (each merges into the one before; merge in order):

1. `feat/plugin-m2a` → main: core libraries (config, git baseline, change set, trigger filter, redaction, payload, `.intent/` writer) with unit tests.
2. `feat/plugin-m2a-client` → `feat/plugin-m2a`: session state + locks, prover API client, agent-text sanitiser, fake prover.
3. `feat/plugin-m2a-wiring` → `feat/plugin-m2a-client`: hooks, Stop runner, connect flow, CLI, packaging (Claude + Codex placeholder), captured-payload replay and fake-prover integration tests.
4. `feat/plugin-m2a-e2e` → `feat/plugin-m2a-wiring`: `test/e2e/claude-e2e.sh`, README (what is sent, install), connect/config/packaging tests.
5. `feat/plugin-m2a-fixes` → `feat/plugin-m2a-e2e`: review fixes 1-10, `UnitRequest.regions`, e2e script fixes.
6. `feat/plugin-m2b` → `feat/plugin-m2a-fixes`: M2b (`intent check` queue for S5/S6, repo mode, renames/deletes, full skill + commands).
7. `feat/plugin-m5` → `feat/plugin-m2b`: M5 Codex.

## Current step

M5 (Codex) done on `feat/plugin-m5` (PR 7): `hooks/codex-hooks.json` (shell form, `--host codex`, sync Stop timeout 30), `lib/codex.js`, apply_patch capture, modes from `turn_context`, Stop submits + detached finisher (+ exit 2 hand-over of already-finished concerns), silent no-concerns, `test/e2e/codex-e2e.sh` + `codex-trust.mjs`. Tests 131/131 on Node 22 and 18. Codex e2e not run by me (orchestrator).

## Next step

Wait for review/merge of PRs 1-7 and the orchestrator's Codex e2e. Then M6 plugin parts (prompt-injection tests on reviewed code, hook UX pass, token-overhead measurement, install docs).

## Design notes for whoever resumes

- `bin/intent.js` line 1 is an old-syntax Node version check; everything else is in `lib/`. `lib/hooks.js` is host-neutral; `lib/claude.js` holds the Claude output protocol. `lib/codex.js` + `hooks/codex-hooks.json` are the Codex side; the host comes from `--host codex` (or `PLUGIN_ROOT`), never from `CLAUDECODE`.
- State: `${CLAUDE_PLUGIN_DATA}/sessions/<sha256(session)[:32]>.json` (lock file per session), `config.json` (key, api_url, disabled; mode 600), `global.json` (consent shown), `connect.json` (pending connect; mode 600), `intent.log`.
- Runner ownership: each runner/finisher writes `owner {pid, token}`; a newer runner takes over all pending jobs and the older one exits 0. The prompt hook only checks pending jobs when no live owner exists.
- Wake rules: exit 2 only if interactive (`CLAUDE_CODE_ENTRYPOINT=cli`), `stop_hook_active` false, fewer than 3 wakes in 2 min, and no concern file woke the agent in the last 10 min; otherwise a next-prompt note. Findings are deduped for 1 h.

## Open questions

- Is `systemMessage` from UserPromptSubmit/SessionStart visible in the interactive TUI? Docs say yes; `-p` smoke only shows it in the hook_response event. The e2e script checks it in tmux.

## Needs orchestrator

- `test/e2e/claude-e2e.sh` approves via `POST $INTENT_API_URL/v1/e2e/approve/<user_code>` (`X-E2E-Secret`, body `{"handle":"e2e"}`); `E2E_APPROVE_CMD` overrides. Against the fake prover (`node test/helpers/fake-prover.js 47222`, `INTENT_API_URL=http://127.0.0.1:47222`) it approves via `/_control`.
- `node --test test/` fails on Node 22 (directory argument is treated as a module). CI and `npm test` now use `node --test test/*.test.js`.
- Privacy URL in plugin.json/.codex-plugin is a placeholder (`<staging>/privacy`) until the web agent ships the page.
