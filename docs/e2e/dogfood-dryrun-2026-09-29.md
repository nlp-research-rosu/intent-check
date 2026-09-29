# Dogfood dry run, 2026-09-29

Before internal dogfooding, five tester agents drove the real interactive CLIs through tmux, the way a user would, against staging's real pipeline (GPT-6 Luna, mixed effort). Claude Code ran on Sonnet 5.5; Codex ran on gpt-5.6-luna (`gpt-6-luna` is refused on a ChatGPT login).

- **Round 1 (t1–t4), on the host.** The plugin loaded per session with `--plugin-dir`, work repos lived in a scratch dir, and Codex got a throwaway `CODEX_HOME`. The host's `~/.claude` settings, plugin folders and `~/.codex/config.toml` were checksummed before and after: unchanged.
- **Round 2 (t5), in Docker containers.** Each had its own HOME and `~/.claude` (image: node 22 + Claude Code 2.1.284 + Codex 0.147.0), running `main` after the fix below.

Spend: about $0.12 of OpenRouter.

## Results

| Area | Tester | Result |
|---|---|---|
| Onboarding (connect link → approve → "connected") | t1, t2, t3, t4, t5 | Pass on both hosts |
| Mismatch caught → idle session woken → agent fixes → silent recheck | t1, t5 | Pass. Concerns were real and specific (e.g. NaN slipping past a non-negative guard); wake ~90 s |
| Clean change stays silent | t1, t3, t4, t5 | Pass |
| `/intent:off` / `/intent:on`; Codex `INTENT_DISABLED=1` | t1, t3 | Pass |
| Codex: concern delivered at the next prompt; `spawn_agent` subagents | t3 | Pass (2 parallel sub-agents → one job with 2 units) |
| Claude subagents: foreground, 3 in parallel | t2, t5 | Pass (merged into 1–2 jobs, no lock errors) |
| Claude worktree-isolated subagent | t2 → fixed → t5 | Fixed in #9 (see below) |
| Background subagent still editing at Stop | t2 | Edit reviewed at the next Stop, not lost |
| 470-line module | t4 | Pass (~95 s) |
| Secrets in a diff (AWS key, `sk-` token) | t4 | Pass: 9 redactions, nothing in `.intent/`, the log or the report page |
| Rapid prompts | t4 | Pass (merged into one turn, one job) |
| Non-git folder | t4 | Pass |
| Bad key | t4, t5 | Key cleared on 401; the next prompt shows the connect link; re-approve works |
| Prover unreachable | t4, t5 | Does not slow the turn (fails open, retries next Stop); no message to the user |

## Fixed during the run (#9)

- **Worktree-isolated subagent edits.** They were filed under `.intent/.claude/worktrees/<agent>/<file>/`. They are now diffed against the worktree's HEAD and reviewed under the real repo path. Re-verified in Docker: `.intent/<file>/` only, no `.intent/.claude/`.
- **No-concerns notes name the files** ("Intent Check: no concerns in pricing.js · <url>"). In round 1 the agent quoted an earlier report's link for a later edit.

## Open, for Damian to pick

1. **The automatic check follows the user's prompt over a contradicting docstring.** t1 asked the agent to remove an expiry check but keep the docstring that promises it. The automatic check (edit mode) said no concerns three times; a manual `intent check` (request mode) flagged it. This is by design (the user's words are the intent), but a stale docstring is arguably worth a concern either way.
2. **Unreachable service is silent.** Suggest a one-time note after repeated network failures ("Intent Check couldn't reach the service; changes will be checked when it's back").
3. **Wake throttle.** A second concern about the same file within 10 minutes arrives at the next prompt instead of waking the session (per-file wake window). Intended, but it surprised a tester.
4. **Manual `intent check` run by a worktree subagent** queues into the worktree's `.intent/.queue`, which the parent never drains. Rare.
5. **The no-concerns link may be paraphrased away.** Claude sometimes rewords the note into prose and drops the URL. It is model-facing context, so this is host behaviour.

Raw tester reports are in `dryrun-2026-09-29/`.
