# intent-check

The `intent` plugin for Claude Code and Codex. It checks code your agent writes against what you asked for, in the background, and reports concerns with a link to a shareable report.

Status: private pre-release, under construction.

## What is sent, and what stays local

After a turn that changes source files, the plugin sends to the Intent Check service:

- your last few prompts in the session (and the first one), the approved plan and todo items, and the agent's final message for the turn
- the diff of each changed source file and the file itself (large files: only the changed regions)
- the plugin version, host, OS and permission mode
- `.intent/NOTES.md`, if present

Obvious secrets (private keys, cloud and API tokens, `KEY=value` lines with random-looking values) are masked on your machine before anything is sent. Files such as `.env*`, `*.pem` and `id_rsa*` are never sent. Tests, UI components, generated and vendored code, config and docs are not sent either.

Every upload is listed in `.intent/.sent.log` in your repo (paths, sizes, time, URL; never contents). Results are written to `.intent/`, which is meant to be committed; its README explains how to keep it out of git.

Turn it off with `/intent:off` in Claude Code (back on with `/intent:on`), or set `INTENT_DISABLED=1` or `DO_NOT_TRACK=1` on either host. While off, nothing is sent.

## Install (Claude Code)

Requires Node 18 or newer on your `PATH`.

In a Claude Code session, type:

```
/plugin install intent --marketplace nlp-research-rosu/intent-check
```

It asks you to confirm the source, then installs. Or, in a terminal:

```bash
claude plugin marketplace add nlp-research-rosu/intent-check && claude plugin install intent@intentcomputing
```

Then restart Claude Code or run `/reload-plugins`. Your first prompt shows a link to connect your account; once you approve it, checks start. The saved key lives in Claude Code's plugin data folder, which is removed when you uninstall the plugin.

## Install (Codex CLI 0.147 or newer)

In a terminal:

```bash
codex plugin marketplace add nlp-research-rosu/intent-check && codex plugin add intent@intentcomputing
```

Then start `codex` and choose "Trust all and continue" when it says the plugin's hooks need review (or trust them in `/hooks`). Your first prompt shows the link to connect your account.

- Codex cannot wake an idle session, so concerns reach the agent with your next message (or at the end of the same turn, if the check already finished). Clean checks stay silent.
- Codex does not load plugin slash commands, so there is no `/intent:off`. To turn checks off, set `INTENT_DISABLED=1` when starting Codex, or ask the agent to turn Intent Check off (it runs the plugin's `intent.js off`, which may need your approval to write outside the sandbox).
- To ask for a review, ask the agent to check specific files ("check auth.py with Intent Check") or the whole repo.

## Asking for a review

Ask the agent to check specific files, or the whole repo ("check auth.py with Intent Check"); the `intent-check` skill runs `intent check <paths>` for it, and the review runs after the turn. In a project without git, run `intent check` from the project root (the folder the session started in).

## Sample reports

Reports from the staging service:

- [orders.ts: pagination](https://web-staging-7e1c.up.railway.app/r/XCIS3Vb88lln4Zj6Fa4pSX)
- [dedupe.go: order of results](https://web-staging-7e1c.up.railway.app/r/R5gTYyfhQRfH6vnJKLKt7j)
- [Proration rounding](https://web-staging-7e1c.up.railway.app/r/wQTp6MDv1EZ3PGelmcK2Kt)

## Development

- Zero runtime dependencies. Plain ESM JavaScript, Node 18 syntax.
- `npm test` (node:test) and `node contract/hash.mjs`. `test/e2e/claude-e2e.sh` drives a real Claude Code session through tmux; `test/e2e/codex-e2e.sh` runs `codex exec` in an isolated `CODEX_HOME`.
- Contract with the backend: `contract/` (identical copy in `nlp-research-rosu/intent-check-prover`).
- Config: `INTENT_API_URL` overrides the service URL, `INTENT_API_KEY` the saved key.
- `NOTICE` lists the Apache-2.0 code this plugin ports from Anthropic's security-guidance plugin.
