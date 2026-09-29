# Intent Check dry run — tester t4

## Summary
Core flow works well: connect, upload, redact, review, and stay-silent-on-clean-code all behaved correctly, with sensible LLM verdicts and no timeouts even on a 473-line file. The one real problem is **silent failure**: a bad API key and an unreachable prover both fail with zero user-visible signal — the agent finishes the turn normally and the user has no idea Intent Check stopped working or how to fix it.

## Table of checks

| # | What I did | Expected | Observed | Verdict | Time-to-result | Report URL |
|---|---|---|---|---|---|---|
| 0 | Onboarding: first prompt, approve via script | "connect your account" → link, then "connected" on next prompt | Exactly as expected | PASS | — | — |
| 1 | Asked for ~300-line inventory.py (3 classes) in one turn | Upload succeeds, report sensible, no timeout/garbage | Wrote 473 lines; job uploaded (37,298 bytes); verdict "No concerns" with correct INTENT.md/SPEC.k/SEMANTICS.k; total 95s (submit→done) | PASS | ~95s | `/r/Ryx8QGYIi9liPagHERThPV` |
| 2 | config.py with fake AWS key (AKIA...), fake secret, fake `sk-proj-` token + boto3 logic | Secrets redacted in what's sent; no leak in `.intent/` or report page | `.sent.log` shows `redactions:9`; grep for all 3 secret literals across `.intent/`, `intent.log`, and the fetched report HTML found zero matches; verdict "No concerns" | PASS | ~16s | `/r/FtH3NI7Z46pXywRC6q7lYo` |
| 3 | 3 rapid small edit prompts back-to-back, no waiting | No superseded jobs / duplicate wakes / confusing mid-turn wake | Claude Code itself queued and merged all 3 prompts into **one turn** (`turn":"c873585a"`); the plugin submitted exactly **one** job for the merged diff; correctly scoped verdict ("config.py request... outside this file's scope") | PASS | ~58s | `/r/2OnGROUVN0UB6ajWkEtFvi` |
| 4 | Clean, uncontroversial constant addition | Stays silent, no wake | Verdict "No concerns", no wake message, session continued normally | PASS | ~17s | `/r/7LNaqPSaN3AujW9ztYYdD1` |
| 5 | Edit in a plain (non-git) folder, second session (dry-t4b) | Works, or fails gracefully | Worked normally: file written, job submitted (1,436 bytes), verdict "No concerns" | PASS | ~17s | `/r/iHv8rWJdQvPnHG05aGal8I` |
| 6 | Replaced `api_key` with `ic_` + 38×`x`, started session, made an edit | User sees a clear error / fix hint | **Nothing shown to the user at all.** Turn completed normally ("done 8:13 PM"); debug log shows `job.submit_failed status:401 code:unauthorized`; `.sent.log` records `status:"failed:401"`; `.intent/` files were left stale (last good verdict) | **FAIL (bug, see below)** | n/a (silent) | n/a |
| 7 | `INTENT_API_URL=http://127.0.0.1:9`, made an edit | No blocking/slowdown; some error signal | Turn completed in 9s, not slowed; but again **zero user-visible message**; log shows `job.submit_failed status:0 code:network` | ODD (no block, but silent) | n/a (silent) | n/a |
| 8 | Session without `--plugin-dir`, same repo, `.intent/` still present | No leftover noise | Edit happened normally; no Intent Check hooks fired, no entries added to `intent.log` or `.sent.log`; `git status` shows `.intent/`, `config.py`, `inventory.py` all untracked (as before) — no auto-add, no surprise commits | PASS | — | — |

## Bugs

### Bug 1 — Major: bad/invalid API key fails completely silently
- **Repro:** stop all sessions for the plugin; overwrite `api_key` in `~/.claude/plugins/data/intent-t4-inline/config.json` with `ic_` + 38×`x`; start a new Claude session with the plugin; make any code edit.
- **Evidence (debug log, secrets not present):**
  ```
  {"t":"...","event":"job.submit_failed","status":401,"code":"unauthorized","reason":null}
  ```
  `.intent/.sent.log`:
  ```
  {"time":"...","status":"failed:401","job_id":null,"report":null,"paths":["inventory.py"],"bytes":41200,"redactions":0}
  ```
- **User-facing pane:** nothing. `pane | grep -iE "intent|error|unauth|401|fail"` matched only the cwd path string, no actual message. The turn just ends as if everything were fine, and `.intent/inventory.py/meta.json` is left pointing at the previous (stale) successful review — so a user comparing timestamps would have no reason to suspect anything's wrong.
- **Impact:** a user who fat-fingers a re-paste of their key, or whose key gets revoked/expires, has no way to discover Intent Check has stopped working short of reading the debug log manually. There is no "Intent Check: auth error, run X to reconnect" message anywhere.
- **Suggested fix:** on 401/403, surface a one-line hook message (like the existing "connect"/"connected" messages) telling the user their key is invalid and how to reconnect (e.g., re-run the connect flow or `/intent:off` to disable).

### Bug 2 — Minor/major (judgment call): prover-unreachable is equally silent
- **Repro:** start a session with `INTENT_API_URL=http://127.0.0.1:9`; make an edit.
- **Evidence:** `{"event":"job.submit_failed","status":0,"code":"network","reason":null}`, `.sent.log` `"status":"failed:network"`.
- **Good news:** this does **not** block or slow the agent — the turn completed in 9s, same as normal. So the fail-open design is correct and non-intrusive.
- **Bad news:** same as Bug 1 — zero visible signal. Combined with Bug 1 this means *any* failure mode of the whole upload pipeline is invisible to the user by design, which will make outages/misconfig very hard to notice or debug for a real user. I'd bucket this with Bug 1: one shared fix (a lightweight failure notice, rate-limited so it doesn't spam) covers both.

## UX notes
- **Onboarding wording is good.** The `SessionStart` message ("Intent Check is on. After a turn that changes source files... obvious secrets are masked first... To turn it off: /intent:off") is clear and sets expectations well.
- **"connected" doesn't repeat per-repo/session.** In the second session (non-git folder, same already-approved account), `SessionStart` fired in the debug log but produced *no* visible output — no "Intent Check is on" banner at all in that session's transcript. That's probably intentional (don't re-nag once approved), but it means a first-time user in a *second* repo gets no confirmation the plugin is active there. Minor — worth a one-line "Intent Check: active" on first turn per repo, distinct from the connect/connected flow.
- **Rapid-fire prompts are handled well, but not by the plugin.** Claude Code itself queues/merges rapid inputs into a single turn before the plugin ever sees them, so "duplicate wakes" isn't really a scenario the plugin needs to worry about under normal CLI usage. Good — but if the product ever runs headless/scripted with prompts truly interleaved mid-turn, this merge behavior won't protect it; worth a note for the Codex side (BRIEF says Codex concerns land at the next prompt, implying its queuing model differs).
- **LLM verdict quality: good.** In every clean-code run, the verdict was "No concerns" and the INTENT.md assumptions were accurate and specific (e.g., correctly identified that a `Q`→`qty` rename request had no matching site to rename, correctly scoped a multi-file mention to "outside this file's scope"). One mildly confusing artifact: INTENT.md for the very first inventory.py review noted "The user also requested a one-sentence greeting, which this module does not provide" — this is technically true (recent-prompt context bled in from the prior unrelated "say hello" turn) but reads oddly out of context on a report page; a user skimming just that report might wonder what greeting is being referred to.
- **Report pages render server-side "Still checking" then finish** — polling every 5s found results settling in 15–60s per job, well under the stated 40–80s budget in this run; no case took anywhere near the 4-minute patience window.
- **Redaction is solid.** 9 redactions logged for 3 secrets (AWS key id, AWS secret, sk- token) — plausibly one redaction per occurrence across diff + prompt-history context. No leak found anywhere I could check (`.intent/*`, `intent.log`, fetched report HTML).
- **Uninstall-ish behavior is clean.** Running without `--plugin-dir` leaves `.intent/` untouched, adds no log entries, and doesn't silently commit or stage anything — `git status` was identical before/after.

## Cleanup performed
- Killed `dry-t4` and `dry-t4b` tmux sessions; verified no stray `plugin-t4` claude processes remain.
- Restored `config.json` from backup after the bad-key test (backup file removed after restore, contents never printed).
- Repo left in place at `$DRY/t4/app` and `$DRY/t4/nogit`.
- Deleted `~/.claude/plugins/data/intent-t4-inline` at the end (per brief).
