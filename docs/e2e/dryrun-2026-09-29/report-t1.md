# Intent Check dry run — tester t1

## Summary

Onboarding, `/intent:off`/`/intent:on`, silent-on-clean-code, and the status/report-lookup flow all worked cleanly and matched reality when curl-checked. The one real bug worth escalating: the **automatic** post-turn check (`mode:edit`) gave "no concerns" on a genuine docstring/behavior mismatch (docstring says "rejects expired coupons," code doesn't check expiry at all) across three separate auto-checks of that exact code — it only caught the bug when I manually invoked the `intent:check` skill (`mode:request`) on the same unchanged file. The wake→fix→recheck→silence loop, once triggered, worked exactly as advertised.

## Table of checks

| # | what I did | expected | observed | verdict | time | report URL |
|---|---|---|---|---|---|---|
| 1 | Fresh session start in `t1/shop` | Connect line, then approve, then "connected" on next prompt | SessionStart showed the "Intent Check: connect your account → .../connect/DFKF-LCPK" line plus a plain-English explainer; after `approve`, next `UserPromptSubmit` showed "Intent Check: connected." | PASS | ~10s to approve | — |
| 2a | Asked for `apply_coupon` with a deliberately contradictory instruction ("reject expired coupons" but "don't worry about checking expiry, keep it simple") | Agent either takes the bait (bug) or resolves it correctly | Agent resolved it correctly on its own (added the `date.today()` check despite my "don't check expiry" hint), explained the tension in its reply. Upload happened, verdict `no_concerns` — correct, no bug present | PASS | job took 2m15s | `/r/beHolT5F5QQrzRQs8dsfG2` |
| 2b | Forced a real bug: told agent to strip the expiry check but keep the docstring saying "rejects expired coupons" | Concern should be raised; idle wake | Auto-upload (`mode:edit`) came back `no_concerns` — **false negative**, see Bugs #1 | FAIL (missed) | job 43s, no wake | `/r/Vd5CncfE0ReEo5sp7FpftC` |
| 3 | Added `format_price(cents)`, clean well-specified docstring helper | Stays silent | `no_concerns`, no wake, no noise | PASS | job 43s | `/r/msmiZr7qcww3erRt194BQZ` |
| 4a | `/intent:off`, then edited `orders.py` (added `round_half_up`) | Nothing uploaded | `.sent.log` unchanged after the edit; hook logged edit events but no `job.submitted` | PASS | — | — |
| 4b | `/intent:on`, then edited `orders.py` again (docstring example) | Upload resumes | `job.submitted` fired immediately on the next Stop hook, verdict `no_concerns` | PASS | job 17s | `/r/tNYfnxiy8NyhBggERddhpe` |
| 5a | Asked Claude "what did intent check find on orders.py?" | Can locate/summarize report from local state | Correctly summarized which turns were reviewed vs. skipped (while off), and itself flagged the still-unresolved docstring/expiry mismatch by reading `.intent/` — without me even asking about that bug | PASS | instant (local files) | n/a |
| 5b | Asked to "run the intent status skill" | Some form of "intent status" | No such skill name exists; Claude said so and listed the real ones (`intent:check`, `intent:on`, `intent:off`). Minor naming mismatch vs. the brief's "intent status" phrasing | ODD | — | — |
| 5c | Manually invoked `intent:check` on `orders.py` (same file, unchanged since 2b/3/4b, no new edits) | Same verdict as recent auto-checks (no_concerns) since nothing changed | **Caught the bug this time**: verdict `concerns`, "Expired coupons are applied instead of rejected (orders.py:33)". Session woke with the concern, agent asked which fix I wanted, then fixed it on request | PASS (concern correctly found) but confirms #1 is real | job 59s, woke immediately | `/r/Ab48NF87WnppYntg2tlCZn` |
| 5d | Told agent to restore the expiry check | Fix applied, recheck silent | Fixed correctly (`date.today()` check + `ValueError` + added a regression test), auto-recheck came back `no_concerns`, **no second wake** | PASS | recheck 17s | `/r/0Asd73yFX9mvdV86FDmZp7` |
| 6 | Watched status line and general noise throughout | No visible plugin clutter | Status line never showed anything Intent-Check-specific (just Claude Code's normal "accept edits on" line); all Intent Check output is via the `⎿` note lines, which are compact and only appear at connect/connected/off/on/concern points | PASS | — | — |

## Bugs

**#1 — major — auto-mode false negative on a docstring/behavior mismatch that manual `intent:check` catches on the identical file.**

Repro:
1. Have Claude write `apply_coupon(total_cents, coupon)` whose docstring says "Rejects expired coupons by raising ValueError" but whose body has no expiry check at all (any expired coupon in `COUPONS` silently applies).
2. Let the turn finish; the plugin auto-uploads (`mode:edit`) and comes back `no_concerns`. This reproduced identically across **three consecutive auto-checks** of that same broken code (after the original edit, after adding `format_price`, and after adding `round_half_up` + a docstring example) — job IDs `Vd5CncfE0ReEo5sp7FpftC`, `msmiZr7qcww3erRt194BQZ`, `tNYfnxiy8NyhBggERddhpe`, all `no_concerns`, spanning ~13 minutes and several unrelated edits, with the bug present and untouched the whole time.
3. Run `intent:check` on `orders.py` manually (skill → `mode:request`, no new edits since step 2) → verdict flips to `concerns`, correctly citing `orders.py:33` and "Expired coupons are applied instead of rejected."

Evidence (`.intent/orders.py/INTENT.md` after the *auto* check that missed it, job `Vd5CncfE0ReEo5sp7FpftC`):
> "`apply_coupon` must clamp the discounted total at zero and must not check coupon expiry; its docstring still says expired coupons are rejected."

The auto-mode's own derived intent *states the contradiction in plain English* and still verdicts `no_concerns`. My read: `mode:edit` derives "intent" primarily from the triggering user prompt (I had explicitly asked for this exact contradiction — "remove the expiry check... keep the docstring saying it rejects expired coupons though"), and the prover treats that instruction as authoritative ground truth rather than flagging the docstring itself as a spec claim to check against runtime behavior. `mode:request` (manual `intent:check`) apparently audits the file's own claims more independently and caught it immediately, on the exact same source.

Impact: this is precisely the "tempting mismatch" scenario the product is meant to catch, and it's a case where the *agent itself* (unprompted, in its own chat reply) correctly called out the exact bug ("That docstring is now wrong... Anyone reading the docstring will assume expired coupons are blocked, and they aren't") while the auto-checker said nothing three times in a row. A first-time user who doesn't read the agent's own prose carefully would ship this bug with a false "all clear" from the tool whose whole job is to catch it.

Suggested fix direction: when a user's own prompt explicitly requests introducing/keeping an inconsistency between a docstring/spec comment and the implementation, the checker should still flag the resulting internal inconsistency (docstring vs. code) rather than deferring entirely to the latest prompt as intent — or at minimum weight standing docstrings/comments as an independent intent source the way `mode:request` apparently does.

**#2 — minor — "intent status" has no literal match.**

The brief (and presumably onboarding-facing docs) refer to "`intent status` via the skill," but the installed skill is named `intent:check` (also listed as `intent:intent-check`), not anything containing "status." Asking Claude in plain English "run the intent status skill" got a polite non-match ("There's no intent status skill in this session") rather than the tool being invoked. Once I said "run intent:check on orders.py" it worked immediately (with a one-time permission prompt). Not a functional bug — Claude degrades gracefully and still answers from `.intent/` — but a first-timer typing something close to "check intent status" may bounce once before finding the right phrasing.

## UX notes

- **Onboarding wording is good and low-friction.** The very first message (`SessionStart`) explains in plain terms what will be uploaded, when, and how to mask secrets/opt out, before the connect link even appears. A first-timer gets the "why" up front rather than just a mystery link.
- **The "connected" confirmation on the next prompt is a nice touch** — it doesn't block the first prompt, doesn't require a separate action, and shows up as a small `⎿` note rather than interrupting.
- **No status-line noise.** I watched the status line through the whole session; it never carries Intent-Check-specific clutter. All output is the compact `⎿ Intent Check: ...` note style, only at meaningful moments (connect/connected/off/on/concern). This is the right level of quietness — silent on clean code, visible only when it matters.
- **The wake→fix→recheck→silence loop, once triggered, is genuinely good.** When `intent:check` surfaced the concern, Claude didn't blindly "fix" it — it paused, explained *why* it hadn't just reverted my own explicit instruction, and asked me which of two reasonable fixes I wanted (restore the check vs. fix the docstring). That's the right call given I'd explicitly asked for the broken state. After I picked "restore the check," it fixed it correctly, added a regression test unprompted, and the recheck came back clean with no second wake — exactly the promised behavior.
- **Were the concerns right, wrong, or useless?** The one concern I actually saw (`Ab48NF87WnppYntg2tlCZn`) was precisely right, specific (cited the exact line and the exact failing call), and actionable. My complaint is entirely about *consistency of detection*, not quality when it does fire — see Bug #1.
- **Latency:** auto-checks after a turn landed in 17–65s in my run; the one manual `intent:check` took 59s to complete and wake. All comfortably inside the "40-80s" and "4 minute" guidance in the brief.
- **Report pages match local state exactly.** I curl'd 4 of the 6 report URLs across the session; title/description always matched the local `VERDICT.md`/`meta.json` content (e.g., `Vd5CncfE0ReEo5sp7FpftC` and `0Asd73yFX9mvdV86FDmZp7` both said "No concerns", `Ab48NF87WnppYntg2tlCZn` said "Concerns (1) ... Expired coupons are applied instead of rejected (orders.py:33)").
- **`/intent:off` / `/intent:on` are unambiguous and instant** — one-line confirmation each way, and verified at the hook-log level (no `job.submitted` while off; edits were still tracked/PostToolUse-logged, just never uploaded).
- **Test-file-only edits never triggered a check** in this run (adding tests to `test_orders.py` alone produced `stop.nothing_to_check, files:0` even while intent was on). This looks intentional (nothing to verify intent against in a test-only diff) rather than a bug, but is worth confirming with the team — it means Intent Check won't catch a wrong *test* assertion, only production-code/docstring claims.

## Data left in place

- Repo: `$DRY/t1/shop` (2 commits, clean working tree except `.intent/` which is untracked as intended, `.gitignore` added for `__pycache__/`).
- Plugin data dir `~/.claude/plugins/data/intent-inline/` left in place per instructions (not deleted).
- tmux session `dry-t1` killed at end of run.
