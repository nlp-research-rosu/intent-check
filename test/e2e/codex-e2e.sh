#!/usr/bin/env bash
# Live end-to-end test of the intent plugin on Codex CLI (codex exec), for the orchestrator.
# Not part of `npm test`.
#
#   INTENT_API_URL=https://web-staging-7e1c.up.railway.app E2E_APPROVE_SECRET=... test/e2e/codex-e2e.sh
#
# Isolation: a throwaway CODEX_HOME with auth.json SYMLINKED from ~/.codex, so a token refresh
# during the run writes through to the real ~/.codex/auth.json (that is the point: a copy would go
# stale and break the real login). Nothing else under ~/.codex is written. The plugin is installed
# from this checkout into the throwaway home, and its hooks are trusted by pre-seeding
# [hooks.state] hashes in that home's config.toml only.
#
# Steps: first prompt shows the connect line (as hook context) → scripted approve → key saved →
# seeded-bug edit via apply_patch → Stop returns fast, .intent/ written by the detached poller →
# the concern reaches the agent at the next prompt (resume) → a no-concerns check stays silent →
# /intent:off equivalent (INTENT_DISABLED=1) sends nothing.
#
# Env: INTENT_API_URL (required; 127.0.0.1 = fake prover), E2E_APPROVE_SECRET (staging),
#      E2E_APPROVE_CMD (override), MODEL (default gpt-5.6-luna), INTENT_PIPELINE (default canned), KEEP=1.
set -euo pipefail

: "${INTENT_API_URL:?set INTENT_API_URL}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$HERE/../.." && pwd)}"
MODEL="${MODEL:-gpt-5.6-luna}"
export INTENT_PIPELINE="${INTENT_PIPELINE:-canned}"
FAKE=0
case "$INTENT_API_URL" in http://127.0.0.1:*|http://localhost:*) FAKE=1 ;; esac
if [ "$FAKE" = 0 ]; then : "${E2E_APPROVE_SECRET:?set E2E_APPROVE_SECRET}"; fi
[ -f "$HOME/.codex/auth.json" ] || { echo "no ~/.codex/auth.json"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/intent-codex-e2e-XXXXXX")"
export CODEX_HOME="$WORK/home"
REPO="$WORK/repo"
DATA="$CODEX_HOME/plugins/data/intent-intentcomputing"
PASS=0; FAIL=0
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
ok() { PASS=$((PASS + 1)); log "PASS $*"; }
bad() { FAIL=$((FAIL + 1)); log "FAIL $*"; }
wait_for() { local t=$1; shift; local end=$((SECONDS + t)); until "$@"; do [ $SECONDS -ge $end ] && return 1; sleep 2; done; }
cleanup() {
  # Detached finisher / connect-poll processes run from the throwaway plugin cache; stop them first
  # or they recreate $WORK/home after it is removed.
  local pids
  pids="$(pgrep -f "$WORK/home/plugins/cache" || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 1
  pids="$(pgrep -f "$WORK/home/plugins/cache" || true)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  if [ "${KEEP:-0}" = 1 ]; then log "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

cx() { (cd "$REPO" && INTENT_DEBUG=1 INTENT_API_URL="$INTENT_API_URL" INTENT_CONSOLE_URL="${INTENT_CONSOLE_URL:-$INTENT_API_URL}" codex exec --skip-git-repo-check -s workspace-write -m "$MODEL" "$@" </dev/null) 2>&1; }

approve() {
  local code=$1
  if [ -n "${E2E_APPROVE_CMD:-}" ]; then USER_CODE="$code" bash -c "$E2E_APPROVE_CMD"; return; fi
  if [ "$FAKE" = 1 ]; then
    curl -fsS -X POST "$INTENT_API_URL/_control" -H 'content-type: application/json' -d '{"connectApproved":true}' >/dev/null
  else
    curl -fsS -X POST "$INTENT_API_URL/v1/e2e/approve/$code" -H "X-E2E-Secret: $E2E_APPROVE_SECRET" \
      -H 'content-type: application/json' -d '{"handle":"e2e"}' >/dev/null
  fi
}

mkdir -p "$CODEX_HOME" "$REPO"
ln -s "$HOME/.codex/auth.json" "$CODEX_HOME/auth.json"
git -C "$REPO" init -q
printf '# e2e\n' > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=e2e@example.com -c user.name=e2e commit -qm init

log "installing the plugin into $CODEX_HOME"
codex plugin marketplace add "$PLUGIN_DIR" >/dev/null
codex plugin add intent@intentcomputing >/dev/null
node "$HERE/codex-trust.mjs" >> "$CODEX_HOME/config.toml"
ok "plugin installed and hooks trusted (isolated home)"

# What the plugin handed to Codex, from its own log (codex exec does not print hook context).
emitted() { grep '"event":"hook.output"' "$DATA/intent.log" 2>/dev/null | grep -c "\"$1\"" || true; }

# 1. Connect. The line goes to Codex as hook context (the TUI shows it; exec prints only
#    "hook: UserPromptSubmit Completed"), so check the plugin's output log and ask the model.
OUT="$(cx "Quote verbatim every line in your context that starts with 'Intent Check:', or say NONE. Do not run any commands.")"
if [ "$(emitted connect)" -ge 1 ]; then ok "connect line handed to Codex"; else bad "connect line not emitted"; fi
if printf '%s' "$OUT" | grep -q 'Intent Check: connect your account'; then ok "model saw the connect line"; else bad "model did not see the connect line"; fi
wait_for 20 test -f "$DATA/connect.json" || true
USER_CODE="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).user_code||"")}catch{console.log("")}' "$DATA/connect.json")"
[ -n "$USER_CODE" ] && ok "connect started ($USER_CODE)" || bad "no connect request"
approve "$USER_CODE" || bad "approve failed"
if wait_for 60 grep -q '"keys"' "$DATA/config.json" 2>/dev/null; then ok "key saved"; else bad "key not saved"; fi

# 2. Seeded bug: Stop must return quickly; the detached poller writes .intent/.
T0=$SECONDS
cx "Create pricing.py with exactly four lines: '# pricing.py', 'def apply_discount(price_cents: int, percent: int) -> int:', '    \"\"\"Price in cents after a percentage discount; never below zero.\"\"\"', '    return price_cents - price_cents * percent // 100'. Write it exactly, no clamp. Reply with just: written" > "$WORK/turn1.log"
log "turn 1 took $((SECONDS - T0)) s"
if wait_for 180 test -f "$REPO/.intent/pricing.py/meta.json"; then ok ".intent/pricing.py written"; else bad ".intent/pricing.py missing"; fi
grep -q '"host":"codex"\|"mode":"edit"' "$REPO/.intent/.sent.log" && ok "upload logged" || bad "no upload logged"

# 3. The concern reaches the agent at the next prompt (or already at Stop, if it finished in time).
if grep -q 'Intent Check: [0-9]* concern' "$WORK/turn1.log"; then
  ok "concern handed over at Stop (exit 2)"
else
  # Wait until the detached poller has settled the job, then open the next turn.
  wait_for 120 bash -c "grep -q '\"event\":\"job.done\"' '$DATA/intent.log'" || true
  sleep 2
  OUT="$(cx resume --last "Quote verbatim every line in your context that starts with 'Intent Check:', or say NONE. Do not edit files.")"
  if [ "$(emitted concerns)" -ge 1 ]; then ok "concern handed to Codex at the next prompt"; else bad "concern not emitted"; fi
  if printf '%s' "$OUT" | grep -q 'Intent Check: [0-9]* concern'; then ok "model saw the concern"; else bad "model did not quote the concern"; fi
fi

# 4. No concerns stay silent: a clean file.
N="$(wc -l < "$REPO/.intent/.sent.log")"
cx resume --last "Create util.py with a function double(x) that returns x * 2, with a docstring and a type hint. Reply with just: done" > /dev/null
wait_for 120 bash -c "[ \$(wc -l < '$REPO/.intent/.sent.log') -gt $N ]" && ok "clean file checked" || bad "clean file not checked"
sleep 20
cx resume --last "Reply with just: ok" > /dev/null
if [ "$(emitted no_concerns)" = 0 ]; then ok "no concerns stayed silent"; else bad "a no-concerns note was handed to Codex"; fi

# 5. Off switch: nothing sent.
N="$(wc -l < "$REPO/.intent/.sent.log")"
(cd "$REPO" && INTENT_DISABLED=1 INTENT_API_URL="$INTENT_API_URL" INTENT_CONSOLE_URL="${INTENT_CONSOLE_URL:-$INTENT_API_URL}" codex exec --skip-git-repo-check -s workspace-write -m "$MODEL" resume --last "Append a function triple(x) returning x * 3 with a docstring to util.py. Reply with just: done" </dev/null >/dev/null 2>&1) || true
sleep 20
[ "$(wc -l < "$REPO/.intent/.sent.log")" = "$N" ] && ok "no upload while disabled" || bad "uploaded while disabled"

env -u CODEX_HOME codex login status >/dev/null 2>&1 && ok "real Codex login still valid" || bad "codex login status failed"
log "passed $PASS, failed $FAIL"
[ "$FAIL" = 0 ]
