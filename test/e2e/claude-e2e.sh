#!/usr/bin/env bash
# Live end-to-end test of the intent plugin in a real interactive Claude Code session, driven
# through tmux. For the orchestrator (Gate A); it is not part of `npm test`.
#
#   INTENT_API_URL=https://staging-prover.intentcomputing.org INTENT_CONSOLE_URL=https://staging-prover-console.intentcomputing.org E2E_APPROVE_CMD='...' test/e2e/claude-e2e.sh
#
# Staging runs the canned pipeline, which reports a concern only for the apply_discount bug
# without a clamp (or the marker intent-check:seed-bug), so the seeded edit below triggers it and
# the agent's fix comes back clean.
#
# Steps: start claude with the plugin → setup notice → explicit CLI login → scripted approve →
# key saved → seeded-bug edit → .intent/ written with a report URL → the idle session is woken
# with an "Intent Check:" concern → the agent fixes it (acceptEdits) → the fix is re-checked
# without a second wake → /intent:off stops uploads.
#
# Env:
#   INTENT_API_URL       required. A 127.0.0.1 URL means the fake prover (test/helpers/fake-prover.js).
#   INTENT_CONSOLE_URL   where report links point; defaults to INTENT_API_URL (right for the fake prover only).
#   E2E_APPROVE_CMD      required unless the fake prover is used: a shell command that approves $USER_CODE
#                        in the console (a Clerk-signed-in action; staging needs a Clerk account).
#   INTENT_PIPELINE      optional: canned (default here) or llm, sent as X-Intent-Pipeline.
#   The global intent-check CLI must already be on PATH.
#   MODEL                default haiku.  PLUGIN_DIR  default: this repo.  KEEP=1 keeps the work dir.
#
# Isolation: the plugin loads with --plugin-dir (no install at any scope). Claude Code keeps its
# data in ~/.claude/plugins/data/intent-inline, which this script removes at the end if it did
# not exist before. The machine's security-guidance plugin is disabled for the session.
set -euo pipefail

: "${INTENT_API_URL:?set INTENT_API_URL}"
MODEL="${MODEL:-haiku}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$HERE/../.." && pwd)}"
export INTENT_PIPELINE="${INTENT_PIPELINE:-canned}"
FAKE=0
case "$INTENT_API_URL" in http://127.0.0.1:*|http://localhost:*) FAKE=1 ;; esac
if [ "$FAKE" = 0 ]; then : "${E2E_APPROVE_CMD:?set E2E_APPROVE_CMD}"; fi
intent-check --version >/dev/null

S="intent-e2e-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/intent-e2e-XXXXXX")"
REPO="$WORK/repo"
DATA="$HOME/.claude/plugins/data/intent-inline"
DATA_EXISTED=0; [ -d "$DATA" ] && DATA_EXISTED=1
PASS=0; FAIL=0
LOGIN_PID=""

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
ok() { PASS=$((PASS + 1)); log "PASS $*"; }
bad() { FAIL=$((FAIL + 1)); log "FAIL $*"; }
pane() { tmux capture-pane -p -J -S -3000 -t "$S" 2>/dev/null || true; }
# Type the text, wait, then submit with C-m: a long paste followed at once by Enter sometimes
# stays in the input box without being submitted.
send() { tmux send-keys -t "$S" -l "$1"; sleep 1; tmux send-keys -t "$S" C-m; }
# wait_for <seconds> <command...>: poll until the command succeeds.
wait_for() { local t=$1; shift; local end=$((SECONDS + t)); until "$@"; do [ $SECONDS -ge $end ] && return 1; sleep 2; done; }
pane_has() { pane | grep -qE "$1"; }
pane_count() { pane | grep -cE "$1" || true; }
sent_count() { [ -f "$REPO/.intent/.sent.log" ] && wc -l < "$REPO/.intent/.sent.log" | tr -d ' ' || echo 0; }

cleanup() {
  if [ -n "$LOGIN_PID" ]; then kill "$LOGIN_PID" 2>/dev/null || true; wait "$LOGIN_PID" 2>/dev/null || true; fi
  tmux kill-session -t "$S" 2>/dev/null || true
  if [ "$DATA_EXISTED" = 0 ]; then rm -rf "$DATA"; fi
  rm -rf "$HOME/.claude/projects/$(printf '%s' "$REPO" | sed 's#[^A-Za-z0-9]#-#g')" 2>/dev/null || true
  if [ "${KEEP:-0}" = 1 ]; then log "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

approve() {
  local code=$1
  if [ -n "${E2E_APPROVE_CMD:-}" ]; then USER_CODE="$code" bash -c "$E2E_APPROVE_CMD"; return; fi
  curl -fsS -X POST "$INTENT_API_URL/_control" -H 'content-type: application/json' -d '{"connectApproved":true}' >/dev/null
}

mkdir -p "$REPO"
git -C "$REPO" init -q
printf '# e2e\n' > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=e2e@example.com -c user.name=e2e commit -qm init

log "starting claude in tmux session $S (plugin: $PLUGIN_DIR, api: $INTENT_API_URL)"
tmux new-session -d -s "$S" -x 220 -y 60 \
  "cd '$REPO' && XDG_CONFIG_HOME='$WORK/xdg' INTENT_API_URL='$INTENT_API_URL' INTENT_CONSOLE_URL='${INTENT_CONSOLE_URL:-$INTENT_API_URL}' INTENT_PIPELINE='$INTENT_PIPELINE' claude --plugin-dir '$PLUGIN_DIR' \
   --settings '{\"enabledPlugins\":{\"security-guidance@claude-plugins-official\":false}}' --model '$MODEL' --permission-mode acceptEdits; sleep 600"

# Folder-trust dialog, then the input box.
for _ in $(seq 1 30); do
  # "Quick safety check: Is this a project you trust?" defaults to "No, exit": move to Yes first.
  if pane_has 'Quick safety check|project you trust'; then tmux send-keys -t "$S" Down; sleep 0.5; tmux send-keys -t "$S" Enter; sleep 2; fi
  if pane_has 'trust (this|the files in this) folder|Do you trust'; then tmux send-keys -t "$S" Enter; sleep 2; fi
  pane_has '(\? for shortcuts|accept edits on|╭─)' && break
  sleep 1
done

# 1. Hooks give guidance; the explicit global CLI command starts login.
send "Reply with just: hi"
if wait_for 60 pane_has 'onboarding'; then ok "setup guidance shown"; else bad "setup guidance not visible"; fi
XDG_CONFIG_HOME="$WORK/xdg" INTENT_API_URL="$INTENT_API_URL" INTENT_CONSOLE_URL="${INTENT_CONSOLE_URL:-$INTENT_API_URL}" intent-check login > "$WORK/login.jsonl" 2>&1 &
LOGIN_PID=$!
wait_for 20 grep -q 'verification_url' "$WORK/login.jsonl" || true
USER_CODE="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).user_code||"")}catch{console.log("")}' "$WORK/login.jsonl")"
[ -n "$USER_CODE" ] && ok "explicit CLI login started ($USER_CODE)" || bad "CLI login did not start"

# 2. Approve and wait for the key.
approve "$USER_CODE" || bad "approve command failed"
CRED="$WORK/xdg/intent-check/credentials.json"
if wait_for 60 grep -q '"keys"' "$CRED" 2>/dev/null; then
  wait "$LOGIN_PID" && ok "key saved by intent-check login" || bad "CLI login failed"
  LOGIN_PID=""
else bad "key not saved"; exit 1; fi
[ "$(stat -c %a "$CRED" 2>/dev/null || stat -f %Lp "$CRED")" = 600 ] && ok "credentials.json is mode 600" || bad "credentials.json mode"
send "Reply with just: ready"
if grep -q '"status":"connected"' "$WORK/login.jsonl"; then ok "CLI confirmed connected"; else bad "CLI did not confirm connection"; fi

# 3. Seeded-bug edit.
# One line only: a newline typed into the TUI would submit the prompt early.
# Four lines (docstring included) clear the 3-changed-lines trigger. The prompt states the intent
# (never below zero) but not how to meet it, so after the wake the agent is free to fix the code.
send "Add pricing.py with a function apply_discount(price_cents: int, percent: int) -> int that applies a percentage discount to a price in cents. It should never go below zero. Use exactly four lines: the comment '# pricing.py', the def line, a one-line docstring, and the body 'return price_cents - price_cents * percent // 100'. Reply with just: written"
# The file as written by the seed turn: captured at upload time, before any wake-up can change it.
wait_for 120 test -s "$REPO/.intent/.sent.log" || true
BEFORE="$(sha256sum "$REPO/pricing.py" 2>/dev/null | cut -c1-64)"
if wait_for 120 test -f "$REPO/.intent/pricing.py/meta.json"; then ok ".intent/pricing.py written"; else bad ".intent/pricing.py missing"; fi
URL="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).url)}catch{console.log("")}' "$REPO/.intent/pricing.py/meta.json")"
case "$URL" in http*/tasks/*) ok "report URL $URL" ;; *) bad "no report URL in meta.json" ;; esac
[ -f "$REPO/.intent/.ignore" ] && [ "$(cat "$REPO/.intent/.ignore")" = "*" ] && ok ".intent/.ignore holds *" || bad ".intent/.ignore"

# 4. The idle session is woken with the concern, and the agent fixes it (acceptEdits).
if wait_for 300 pane_has 'Intent Check(: [0-9]+ concern| found concerns)'; then ok "idle session woken with a concern"; else bad "no wake-up seen"; fi
changed() { [ "$(sha256sum "$REPO/pricing.py" | cut -c1-64)" != "$BEFORE" ]; }
if wait_for 60 changed; then
  ok "agent fixed pricing.py after the wake"
else
  # In a mode that asks first (or if the agent just reported the concern), ask for the fix.
  send "Please fix what Intent Check found."
  if wait_for 180 changed; then ok "agent fixed pricing.py when asked"; else bad "no fix after the wake"; fi
fi

# 5. The fix is re-checked silently: a second upload, no second wake.
WAKES="$(pane_count 'Intent Check(: [0-9]+ concern| found concerns)')"
if wait_for 300 bash -c "[ \$(wc -l < '$REPO/.intent/.sent.log') -ge 2 ]"; then ok "fix re-checked"; else bad "fix not re-checked"; fi
sleep 45
[ "$(pane_count 'Intent Check(: [0-9]+ concern| found concerns)')" -le "$WAKES" ] && ok "no second wake for the fixed file" || bad "woke again for the same file"

# 6. /intent:off stops uploads.
send "/intent:off"
if wait_for 60 pane_has 'Intent Check is off'; then ok "/intent:off confirmed"; else bad "/intent:off output not seen"; fi
N="$(sent_count)"
send "Append a function double(x) that returns x * 2 to pricing.py, with a docstring and a type hint. Reply with just: added"
sleep 90
[ "$(sent_count)" = "$N" ] && ok "no upload while off" || bad "uploaded while off"

log "passed $PASS, failed $FAIL"
[ "$FAIL" = 0 ]
