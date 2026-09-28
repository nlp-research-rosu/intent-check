# intent-check

The `intent` plugin for Claude Code (Codex support is coming). It checks code your agent writes against what you asked for, in the background, and reports concerns with a link to a shareable report.

Status: private pre-release, under construction.

## What is sent, and what stays local

After a turn that changes source files, the plugin sends to the Intent Check service:

- your last few prompts in the session (and the first one), the approved plan and todo items, and the agent's final message for the turn
- the diff of each changed source file and the file itself (large files: only the changed regions)
- the plugin version, host, OS and permission mode

Obvious secrets (private keys, cloud and API tokens, `KEY=value` lines with random-looking values) are masked on your machine before anything is sent. Files such as `.env*`, `*.pem` and `id_rsa*` are never sent. Tests, UI components, generated and vendored code, config and docs are not sent either.

Every upload is listed in `.intent/.sent.log` in your repo (paths, sizes, time, URL; never contents). Results are written to `.intent/`, which is meant to be committed; its README explains how to keep it out of git.

Turn it off with `/intent:off` (back on with `/intent:on`), or set `INTENT_DISABLED=1` or `DO_NOT_TRACK=1`. While off, nothing is sent.

## Install (Claude Code)

Requires Node 18 or newer on your `PATH`.

```bash
claude plugin marketplace add nlp-research-rosu/intent-check
claude plugin install intent@intentcomputing
```

Then restart Claude Code or run `/reload-plugins`. Your first prompt shows a link to connect your account; once you approve it, checks start. The saved key lives in Claude Code's plugin data folder, which is removed when you uninstall the plugin.

## Development

- Zero runtime dependencies. Plain ESM JavaScript, Node 18 syntax.
- `npm test` (node:test) and `node contract/hash.mjs`. `test/e2e/claude-e2e.sh` drives a real Claude Code session through tmux.
- Contract with the backend: `contract/` (identical copy in `nlp-research-rosu/intent-check-prover`).
- Config: `INTENT_API_URL` overrides the service URL, `INTENT_API_KEY` the saved key.
- `NOTICE` lists the Apache-2.0 code this plugin ports from Anthropic's security-guidance plugin.
