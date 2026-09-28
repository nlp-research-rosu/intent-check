# Plugin agent status

Milestone: M2a (Claude Code plugin core). Stacked PRs (each merges into the one before; merge in order):

1. `feat/plugin-m2a` → main: core libraries (config, git baseline, change set, trigger filter, redaction, payload, `.intent/` writer) with unit tests.
2. `feat/plugin-m2a-client` → `feat/plugin-m2a`: session state + locks, prover API client, agent-text sanitiser, fake prover.
3. `feat/plugin-m2a-wiring` → `feat/plugin-m2a-client`: hooks, Stop runner, connect flow, CLI, packaging (Claude + Codex placeholder), captured-payload replay and fake-prover integration tests.
4. `feat/plugin-m2a-e2e` → `feat/plugin-m2a-wiring`: `test/e2e/claude-e2e.sh`, README (what is sent, install), connect/config/packaging tests.
5. `feat/plugin-m2a-fixes` → `feat/plugin-m2a-e2e`: review fixes 1-10, `UnitRequest.regions`, e2e script fixes.
6. `feat/plugin-m2b` → `feat/plugin-m2a-fixes`: M2b (`intent check` queue for S5/S6, repo mode, renames/deletes, full skill + commands).

## Current step

M2b done on `feat/plugin-m2b` (PR 6). Tests 121/121 on Node 22 and 18. Live `claude -p "/intent:check pricing.py"` smoke against the fake prover: the skill command queued the file and the detached Stop runner submitted a `request` job.

## Next step

M5 (Codex): fill `hooks/codex-hooks.json` (shell form, sync Stop timeout 30), `lib/codex.js` output protocol, host detection by `PLUGIN_ROOT`, `apply_patch` path parsing, `turn_context` modes from the transcript, sync Stop that submits + spawns a detached poller, silent no-concerns, mkdir -p data dir.

## Design notes for whoever resumes

- `bin/intent.js` line 1 is an old-syntax Node version check; everything else is in `lib/`. `lib/hooks.js` is host-neutral; `lib/claude.js` holds the Claude output protocol. Codex gets `lib/codex.js` + `hooks/codex-hooks.json` in M5 without touching `hooks/hooks.json`.
- State: `${CLAUDE_PLUGIN_DATA}/sessions/<sha256(session)[:32]>.json` (lock file per session), `config.json` (key, api_url, disabled; mode 600), `global.json` (consent shown), `connect.json` (pending connect; mode 600), `intent.log`.
- Runner ownership: each runner/finisher writes `owner {pid, token}`; a newer runner takes over all pending jobs and the older one exits 0. The prompt hook only checks pending jobs when no live owner exists.
- Wake rules: exit 2 only if interactive (`CLAUDE_CODE_ENTRYPOINT=cli`), `stop_hook_active` false, fewer than 3 wakes in 2 min, and no concern file woke the agent in the last 10 min; otherwise a next-prompt note. Findings are deduped for 1 h.

## Open questions

- Is `systemMessage` from UserPromptSubmit/SessionStart visible in the interactive TUI? Docs say yes; `-p` smoke only shows it in the hook_response event. The e2e script checks it in tmux.

## Needs orchestrator

- `test/e2e/claude-e2e.sh` approves via `POST $INTENT_API_URL/v1/e2e/approve/<user_code>` (`X-E2E-Secret`, body `{"handle":"e2e"}`); `E2E_APPROVE_CMD` overrides. Against the fake prover (`node test/helpers/fake-prover.js 47222`, `INTENT_API_URL=http://127.0.0.1:47222`) it approves via `/_control`.
- `node --test test/` fails on Node 22 (directory argument is treated as a module). CI and `npm test` now use `node --test test/*.test.js`.
- Privacy URL in plugin.json/.codex-plugin is a placeholder (`<staging>/privacy`) until the web agent ships the page.
