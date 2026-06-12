#!/usr/bin/env bash
# End-to-end smoke test for the Skool gate + per-user isolation.
#
# Modes:
#   ./scripts/smoke_test.sh local           # spins up a Flask server on a temp DB
#   ./scripts/smoke_test.sh prod  https://creatorgrowth.com   # hits live server
#
# Two-user version: --user-a + --user-b override the default handles.
# Default: theaiandy + andytest (so you can play both roles yourself, no Mike needed).
#
# Exits 0 iff ALL 7 assertions pass. Prints PASS/FAIL per step.
set -u

MODE="${1:-local}"
BASE="${2:-http://127.0.0.1:5050}"
USER_A_EMAIL="${USER_A_EMAIL:-andhaf94@gmail.com}"
USER_A_HANDLE="${USER_A_HANDLE:-theaiandy}"
USER_B_EMAIL="${USER_B_EMAIL:-andytest@example.com}"
USER_B_HANDLE="${USER_B_HANDLE:-andytest}"
DM_VERIFY_TOKEN_LOCAL="${DM_VERIFY_TOKEN:-smoke-test-token}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# ── tracking ─────────────────────────────────────────────
PASS=0
FAIL=0
declare -a FAIL_NAMES

step() { printf "\n──── %s ────\n" "$1"; }
assert_eq() {
    local what="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        printf "  ✓ %s (=%s)\n" "$what" "$actual"
        PASS=$((PASS+1))
    else
        printf "  ✗ %s — expected %s, got %s\n" "$what" "$expected" "$actual"
        FAIL=$((FAIL+1))
        FAIL_NAMES+=("$what")
    fi
}
assert_true() {
    local what="$1" cond="$2"
    if [[ "$cond" == "true" ]] || [[ "$cond" == "1" ]]; then
        printf "  ✓ %s\n" "$what"
        PASS=$((PASS+1))
    else
        printf "  ✗ %s — got %s\n" "$what" "$cond"
        FAIL=$((FAIL+1))
        FAIL_NAMES+=("$what")
    fi
}

# ── local mode: spin up a server ─────────────────────────
SERVER_PID=""
TEST_DB=""
if [[ "$MODE" == "local" ]]; then
    step "0. Local server boot"
    if ! [[ -f videos.db ]]; then
        printf "  ✗ videos.db missing — run from repo root\n"; exit 2
    fi
    TEST_DB="$REPO/videos_smoketest_$$.db"
    cp videos.db "$TEST_DB"
    printf "  ✓ test DB: %s\n" "$TEST_DB"
    # Kill any prior smoke-test on 5050
    if command -v lsof >/dev/null && lsof -i :5050 -sTCP:LISTEN -t >/dev/null 2>&1; then
        lsof -i :5050 -sTCP:LISTEN -t | xargs -r kill -9 2>/dev/null || true
        sleep 1
    fi
    DB_PATH="$TEST_DB" SECRET_KEY="smoke-test-key" \
        DM_VERIFY_TOKEN="$DM_VERIFY_TOKEN_LOCAL" \
        nohup python3 app.py > /tmp/cg_smoke.log 2>&1 &
    SERVER_PID=$!
    trap 'kill -9 $SERVER_PID 2>/dev/null; rm -f "$TEST_DB"' EXIT
    sleep 3
    if ! curl -fs -o /dev/null "$BASE/api/auth-status"; then
        printf "  ✗ server didn't come up — see /tmp/cg_smoke.log\n"
        tail -20 /tmp/cg_smoke.log
        exit 2
    fi
    printf "  ✓ server up at %s\n" "$BASE"
fi

# ── allowlist seeding ─────────────────────────────────────
step "1. Seed allowlist (user A + user B)"
if [[ "$MODE" == "local" ]]; then
    DB_PATH="$TEST_DB" python3 scripts/skool_allowlist.py add --handle "$USER_A_HANDLE" --email "$USER_A_EMAIL" > /dev/null
    DB_PATH="$TEST_DB" python3 scripts/skool_allowlist.py add --handle "$USER_B_HANDLE" --email "$USER_B_EMAIL" > /dev/null
else
    printf "  (prod mode: assumes you already ran 'scripts/skool_allowlist.py add' on the VPS)\n"
fi
printf "  ✓ seeded %s + %s\n" "$USER_A_HANDLE" "$USER_B_HANDLE"
PASS=$((PASS+1))

# ── A. non-allowlisted handle rejected ────────────────────
step "2. Non-allowlisted callback → 403"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/skool/callback" \
    -H 'Content-Type: application/json' \
    -d '{"code":"x","user_email":"stranger@nowhere.com"}')
assert_eq "non-allowlisted callback" "403" "$HTTP"

# ── B. user A logs in via callback (real OAuth fallback) ──
step "3. User A logs in (callback path, since SKOOL_API_KEY unset)"
rm -f /tmp/cg_jar_a.txt /tmp/cg_jar_b.txt
curl -s -c /tmp/cg_jar_a.txt -b /tmp/cg_jar_a.txt -o /tmp/cg_a_resp.json \
    -X POST "$BASE/api/auth/skool/callback" \
    -H 'Content-Type: application/json' \
    -d "{\"code\":\"a\",\"user_email\":\"$USER_A_EMAIL\"}"
A_HANDLE=$(python3 -c "import json; print(json.load(open('/tmp/cg_a_resp.json'))['user']['handle'])" 2>/dev/null || echo "")
assert_eq "user A canonical handle" "$USER_A_HANDLE" "$A_HANDLE"

# ── C. user A sees their videos ───────────────────────────
step "4. User A sees their own videos"
curl -s -b /tmp/cg_jar_a.txt -o /tmp/cg_a_videos.json "$BASE/api/videos"
A_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/cg_a_videos.json'))))" 2>/dev/null || echo "ERR")
A_UIDS=$(python3 -c "import json; print(sorted({v.get('user_id') for v in json.load(open('/tmp/cg_a_videos.json'))}))" 2>/dev/null || echo "[]")
printf "  A's video count: %s, user_ids: %s\n" "$A_COUNT" "$A_UIDS"
# A should have > 0 videos (the existing ones backfilled to Andy)
if [[ "$A_COUNT" =~ ^[0-9]+$ ]] && [[ "$A_COUNT" -gt 0 ]]; then
    printf "  ✓ user A has %s videos\n" "$A_COUNT"
    PASS=$((PASS+1))
else
    printf "  ✗ user A has %s videos (expected >0)\n" "$A_COUNT"
    FAIL=$((FAIL+1)); FAIL_NAMES+=("A's video count")
fi

# ── D. user B logs in (separate cookie jar) ───────────────
step "5. User B logs in (separate session)"
curl -s -c /tmp/cg_jar_b.txt -b /tmp/cg_jar_b.txt -o /tmp/cg_b_resp.json \
    -X POST "$BASE/api/auth/skool/callback" \
    -H 'Content-Type: application/json' \
    -d "{\"code\":\"b\",\"user_email\":\"$USER_B_EMAIL\"}"
B_OK=$(python3 -c "import json; print(json.load(open('/tmp/cg_b_resp.json')).get('ok'))" 2>/dev/null || echo "ERR")
assert_eq "user B callback ok" "True" "$B_OK"

# ── E. user B sees zero videos (read isolation) ───────────
step "6. User B sees zero videos (read isolation)"
curl -s -b /tmp/cg_jar_b.txt -o /tmp/cg_b_videos.json "$BASE/api/videos"
B_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/cg_b_videos.json'))))" 2>/dev/null || echo "ERR")
assert_eq "user B video count (read isolation)" "0" "$B_COUNT"

# ── F. user B adds a Rickroll → owns 1 ────────────────────
step "7. User B adds a video (write scoping)"
curl -s -b /tmp/cg_jar_b.txt -X POST "$BASE/api/videos" \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}' -o /tmp/cg_b_add.json
ADD_HTTP=$(python3 -c "import json; r=json.load(open('/tmp/cg_b_add.json')); print('201' if r.get('id') else r.get('error','ERR'))" 2>/dev/null || echo "ERR")
printf "  user B insert result: %s\n" "$ADD_HTTP"
# Confirm B now has 1
curl -s -b /tmp/cg_jar_b.txt -o /tmp/cg_b_videos2.json "$BASE/api/videos"
B_COUNT2=$(python3 -c "import json; print(len(json.load(open('/tmp/cg_b_videos2.json'))))" 2>/dev/null || echo "ERR")
assert_eq "user B count after insert" "1" "$B_COUNT2"

# ── G. user A still doesn't see user B's video ────────────
step "8. User A doesn't see user B's video"
curl -s -b /tmp/cg_jar_a.txt -o /tmp/cg_a_videos2.json "$BASE/api/videos"
A_COUNT2=$(python3 -c "import json; print(len(json.load(open('/tmp/cg_a_videos2.json'))))" 2>/dev/null || echo "ERR")
A_HAS_B=$(python3 -c "
import json
rs = json.load(open('/tmp/cg_a_videos2.json'))
b_titles = [v.get('title','') for v in json.load(open('/tmp/cg_b_videos2.json'))]
leaked = any((v.get('title','') in b_titles) for v in rs)
print('1' if leaked else '0')
" 2>/dev/null || echo "ERR")
printf "  A count: %s (was %s)\n" "$A_COUNT2" "$A_COUNT"
assert_eq "A's count unchanged after B's insert" "$A_COUNT" "$A_COUNT2"
assert_eq "A's payload does NOT contain B's titles" "0" "$A_HAS_B"

# ── H. revoke user B → next request 401 ───────────────────
step "9. Revoke user B → next request 401"
if [[ "$MODE" == "local" ]]; then
    DB_PATH="$TEST_DB" python3 scripts/skool_allowlist.py revoke --handle "$USER_B_HANDLE" --reason "smoke test" > /dev/null
else
    printf "  (prod mode: revoke manually via VPS)\n"
fi
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/cg_jar_b.txt "$BASE/api/videos")
assert_eq "revoked user request" "401" "$HTTP"

# ── I. DM-code flow end-to-end ────────────────────────────
step "10. DM-code flow (start → admin-verify → poll)"
if [[ "$MODE" == "local" ]]; then
    DB_PATH="$TEST_DB" python3 scripts/skool_allowlist.py add --handle "$USER_B_HANDLE" --email "$USER_B_EMAIL" > /dev/null
fi
curl -s -X POST "$BASE/api/auth/skool/dm-code/start" \
    -H 'Content-Type: application/json' \
    -d "{\"handle\":\"$USER_B_HANDLE\"}" > /tmp/cg_dm_start.json
CODE=$(python3 -c "import json; print(json.load(open('/tmp/cg_dm_start.json')).get('code',''))" 2>/dev/null || echo "")
if [[ -z "$CODE" ]]; then
    printf "  ✗ DM-code start returned no code: %s\n" "$(cat /tmp/cg_dm_start.json)"
    FAIL=$((FAIL+1)); FAIL_NAMES+=("DM-code start")
else
    printf "  code minted: %s\n" "$CODE"
    # admin-verify (in prod, replace DM_VERIFY_TOKEN_LOCAL with the env var)
    HTTP=$(curl -s -o /tmp/cg_admin_verify.json -w "%{http_code}" \
        -X POST "$BASE/api/auth/skool/dm-code/admin-verify" \
        -H "Authorization: Bearer $DM_VERIFY_TOKEN_LOCAL" \
        -H 'Content-Type: application/json' \
        -d "{\"code\":\"$CODE\",\"sender_handle\":\"$USER_B_HANDLE\",\"source\":\"smoke\"}")
    assert_eq "admin-verify HTTP" "200" "$HTTP"
    # poll
    rm -f /tmp/cg_jar_dm.txt
    HTTP=$(curl -s -o /tmp/cg_dm_poll.json -w "%{http_code}" -c /tmp/cg_jar_dm.txt -b /tmp/cg_jar_dm.txt \
        "$BASE/api/auth/skool/dm-code/poll?code=$CODE")
    assert_eq "DM-code poll mints session" "200" "$HTTP"
    DM_HANDLE=$(python3 -c "import json; print(json.load(open('/tmp/cg_dm_poll.json')).get('user',{}).get('handle',''))" 2>/dev/null || echo "")
    assert_eq "DM-code minted session handle" "$USER_B_HANDLE" "$DM_HANDLE"
fi

# ── J. admin-verify rejects missing bearer ────────────────
step "11. admin-verify without bearer → 401"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$BASE/api/auth/skool/dm-code/admin-verify" \
    -H 'Content-Type: application/json' \
    -d '{"code":"000000"}')
assert_eq "admin-verify no bearer" "401" "$HTTP"

# ── summary ───────────────────────────────────────────────
printf "\n══════════════════════════════════════════════\n"
if [[ "$FAIL" -eq 0 ]]; then
    printf " RESULT: ALL %d ASSERTIONS PASS ✓\n" "$PASS"
    EXIT=0
else
    printf " RESULT: %d PASS, %d FAIL\n" "$PASS" "$FAIL"
    printf " Failed steps:\n"
    for n in "${FAIL_NAMES[@]}"; do printf "   - %s\n" "$n"; done
    EXIT=1
fi
printf "══════════════════════════════════════════════\n"

if [[ -n "$SERVER_PID" ]]; then
    kill -9 "$SERVER_PID" 2>/dev/null || true
fi
if [[ -n "$TEST_DB" ]]; then
    rm -f "$TEST_DB"
fi

exit $EXIT
