# Plugin agent status

Milestone: M2a (Claude Code plugin core). Four stacked PRs (each merges into the one before; merge in order):

1. `feat/plugin-m2a` → main: core libraries (config, git baseline, change set, trigger filter, redaction, payload, `.intent/` writer) with unit tests.
2. `feat/plugin-m2a-client` → `feat/plugin-m2a`: session state + locks, prover API client, agent-text sanitiser, fake prover.
3. `feat/plugin-m2a-wiring` → `feat/plugin-m2a-client`: hooks, Stop runner, connect flow, CLI, packaging (Claude + Codex placeholder), captured-payload replay and fake-prover integration tests.
4. `feat/plugin-m2a-e2e` → `feat/plugin-m2a-wiring`: `test/e2e/claude-e2e.sh`, README (what is sent, install), connect/config/packaging tests.

## Current step

M2a complete; four PRs open. Tests: `npm test` 101/101 on Node 22.22 and Node 18.20 (docker node:18-alpine); `node contract/hash.mjs` ok; `claude plugin validate .` ok.
Live smoke (claude 2.1.284, `--plugin-dir`, `-p`, haiku, fake prover): SessionStart hook output accepted; headless Stop detached, submitted, wrote `.intent/`; `--resume` next prompt received the concern note.

## Next step

M2b: `/intent:check` queue (`.intent/.queue`), repo mode, renames/deletes of unit folders, full skill + commands text. Then M5 (Codex: fill `hooks/codex-hooks.json`, sync Stop + detached poller, `apply_patch` parsing, `turn_context` modes).

## Design notes for whoever resumes

- `bin/intent.js` line 1 is an old-syntax Node version check; everything else is in `lib/`. `lib/hooks.js` is host-neutral; `lib/claude.js` holds the Claude output protocol. Codex gets `lib/codex.js` + `hooks/codex-hooks.json` in M5 without touching `hooks/hooks.json`.
- State: `${CLAUDE_PLUGIN_DATA}/sessions/<sha256(session)[:32]>.json` (lock file per session), `config.json` (key, api_url, disabled; mode 600), `global.json` (consent shown), `connect.json` (pending connect; mode 600), `intent.log`.
- Runner ownership: each runner/finisher writes `owner {pid, token}`; a newer runner takes over all pending jobs and the older one exits 0. The prompt hook only checks pending jobs when no live owner exists.
- Wake rules: exit 2 only if interactive (`CLAUDE_CODE_ENTRYPOINT=cli`), `stop_hook_active` false, fewer than 3 wakes in 2 min, and no concern file woke the agent in the last 10 min; otherwise a next-prompt note. Findings are deduped for 1 h.

## Open questions

- Is `systemMessage` from UserPromptSubmit/SessionStart visible in the interactive TUI? Docs say yes; `-p` smoke only shows it in the hook_response event. The e2e script checks it in tmux.

## Needs orchestrator

- The staging approve route for scripted connect is not defined yet. `test/e2e/claude-e2e.sh` defaults to `POST $INTENT_API_URL/e2e/connect/<user_code>/approve` with `Authorization: Bearer $E2E_APPROVE_SECRET`; set `E2E_APPROVE_CMD` if the prover's route differs. Against the fake prover (`node test/helpers/fake-prover.js 47222`, `INTENT_API_URL=http://127.0.0.1:47222`) it approves via `/_control`.
- `node --test test/` fails on Node 22 (directory argument is treated as a module). CI and `npm test` now use `node --test test/*.test.js`.
- Privacy URL in plugin.json/.codex-plugin is a placeholder (`<staging>/privacy`) until the web agent ships the page.
