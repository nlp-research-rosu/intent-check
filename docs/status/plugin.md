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

Second re-review of #6/#7 fixed (queue retries with stable Idempotency-Key and a 3-try cap, per-item failures, imperative 'without asking' rules, loud off/on failure, non-git subfolder queues, Codex off drops the queue, finisher refresh). Tests 143 (m2b) / 158 (m5) on Node 22 and 18. Against staging on 2026-09-28: claude-e2e 14/14 (22:30-22:33), codex-e2e 13/13 (22:28-22:30), Codex login intact.

#1-#5 merged (main 675c8d8). #6 (M2b, now based on main) and #7 (M5, based on feat/plugin-m2b) carry the review fixes; origin/main is merged into both. Tests 139 (m2b) / 151 (m5) on Node 22 and 18. `test/e2e/codex-e2e.sh` against staging: 13/13 PASS (2026-09-28 22:03), real Codex login intact, no leftover processes or temp dirs.

## Next step

Wait for review/merge of PRs 1-7 and the orchestrator's Codex e2e. Then M6 plugin parts (prompt-injection tests on reviewed code, hook UX pass, token-overhead measurement, install docs).

## Design notes for whoever resumes

- Every hook and command runs `node ${CLAUDE_PLUGIN_ROOT}/bin/intent.js` directly (Claude Code hooks in exec form, so no shell is needed and Windows without `sh` works). `bin/intent` is the legacy POSIX `sh` launcher (issue #22), no longer referenced by any hook or command: it `exec`s `bin/intent.js` when Node >=18 is on PATH, otherwise prints a short no-Node message for `session-start`/`prompt`/`check` and exits 0 silently for everything else. `bin/intent.js` line 1 is an old-syntax Node version check that says so on stderr once per data dir (marker `.node-too-old-<version>`); everything else is in `lib/`. `lib/hooks.js` is host-neutral; `lib/claude.js` holds the Claude output protocol. `lib/codex.js` + `hooks/codex-hooks.json` are the Codex side; the host comes from `--host codex` (or `PLUGIN_ROOT`), never from `CLAUDECODE`.
- State: `${CLAUDE_PLUGIN_DATA}/sessions/<sha256(session)[:32]>.json` (lock file per session), `config.json` (key, api_url, disabled; mode 600), `global.json` (consent shown), `connect.json` (pending connect; mode 600), `intent.log`.
- Runner ownership: each runner/finisher writes `owner {pid, token}`; a newer runner takes over all pending jobs and the older one exits 0. The prompt hook only checks pending jobs when no live owner exists.
- Wake rules: exit 2 only if interactive (`CLAUDE_CODE_ENTRYPOINT=cli`), `stop_hook_active` false, fewer than 3 wakes in 2 min, and no concern file woke the agent in the last 10 min; otherwise a next-prompt note. Findings are deduped for 1 h.

## Open questions

- Codex does not load plugin `commands/` (not in its manifest handling; research/03 lists skills and hooks only), so Codex users turn checks off via the skill (`intent.js off`, may need sandbox escalation) or `INTENT_DISABLED=1`.
- `codex exec` prints only `hook: <Event> Completed`, never hook context; the e2e checks delivery through the plugin log (`hook.output` events) and by asking the model to quote it.

## Needs orchestrator

- `test/e2e/claude-e2e.sh` approves via `POST $INTENT_API_URL/v1/e2e/approve/<user_code>` (`X-E2E-Secret`, body `{"handle":"e2e"}`); `E2E_APPROVE_CMD` overrides. Against the fake prover (`node test/helpers/fake-prover.js 47222`, `INTENT_API_URL=http://127.0.0.1:47222`) it approves via `/_control`.
- `node --test test/` fails on Node 22 (directory argument is treated as a module). CI and `npm test` now use `node --test test/*.test.js`.
- Privacy URL in plugin.json/.codex-plugin is a placeholder (`<staging>/privacy`) until the web agent ships the page.
