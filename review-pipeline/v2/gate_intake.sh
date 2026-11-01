#!/bin/bash
# gate_intake.sh <PR> [worktree]   Re-run before every long step: #19186 merged while its review was being prepared,
# openim #55 merged 26 s after approval, and #19092's ref kept the old head because fetch lacked "+".
set -u
N=$1
[ -n "${RV:-}" ] || { f="$(dirname "$0")/../.pipeline-env"; [ ! -f "$f" ] || . "$f"; }  # run by hand: the /review-pr extension wrote the environment next to the tools
RV=${RV:?set RV}
[ -f "${HANDBOOK:-}" ] || { echo "ABORT: set RV, HANDBOOK and REVIEWER (the /review-pr extension does)" >&2; exit 2; }
REPO=${REPO:?set REPO (owner/name)}
WT=${2:-$(dirname "$RV")/${WT_PREFIX:?set WT_PREFIX}$N}
export GH_TOKEN="$(gh auth token -h github.com -u "$REVIEWER")" || { echo "INTAKE: ABORT no token"; exit 2; }
J=$(gh api "repos/$REPO/pulls/$N" --jq '"\(.state) \(.merged) \(.merged_at) \(.user.login) \(.head.sha) \(.base.ref)"') || { echo "INTAKE: ABORT GET failed"; exit 2; }
read -r STATE MERGED MERGED_AT AUTHOR HEAD BASE <<<"$J"
# The head this review starts from: check_head.sh stops later steps once GitHub has another one.
[ -z "${WORK:-}" ] || { mkdir -p "$WORK" && printf '%s\n' "$HEAD" > "$WORK/head.sha"; }
BB=${BASE_BRANCH:-develop}
DEV=$(gh api repos/$REPO/branches/$BB --jq .commit.sha) || exit 2
rc=0
check() { if [ "$2" = ok ]; then echo "INTAKE: PASS   $1"; else echo "INTAKE: FAIL   $1"; rc=1; fi; }
check "state=$STATE merged=$MERGED mergedAt=$MERGED_AT" "$([ "$STATE $MERGED" = "open false" ] && echo ok)"
BASE_NOTE=$("$(dirname "$0")/check_base.sh" "$REPO" "$N" "$BASE") && BASE_OK=ok || BASE_OK=
check "base=$BASE${BASE_NOTE:+ ($BASE_NOTE)}" "$BASE_OK"
if [ -n "${AUTHOR_PATTERN:-}" ]; then
  check "author=$AUTHOR (khớp authorPattern $AUTHOR_PATTERN)" "$([[ "$AUTHOR" =~ $AUTHOR_PATTERN ]] && echo ok)"
else
  echo "INTAKE: INFO   author=$AUTHOR (pipeline.json không có authorPattern, không kiểm tác giả)"
fi
LOCAL_PR=$(git -C "$RV" rev-parse "refs/remotes/pr/$N" 2>/dev/null)
check "refs/remotes/pr/$N=${LOCAL_PR:0:10} API head=${HEAD:0:10}" "$([ "$LOCAL_PR" = "$HEAD" ] && echo ok)"
WT_HEAD=$(git -C "$WT" rev-parse HEAD 2>/dev/null)
check "worktree $WT HEAD=${WT_HEAD:0:10}" "$([ "$WT_HEAD" = "$HEAD" ] && echo ok)"
LOCAL_DEV=$(git -C "$RV" rev-parse origin/$BB)
if [ "$LOCAL_DEV" = "$DEV" ]; then echo "INTAKE: PASS   origin/$BB=${DEV:0:10} khớp API"; else echo "INTAKE: WARN   origin/$BB=${LOCAL_DEV:0:10}, API ${DEV:0:10}: fetch với dấu + rồi trial lại"; fi
LABELS=$(gh api "repos/$REPO/issues/$N" --jq '[.labels[].name]|join(",")')
echo "INTAKE: INFO   labels=$LABELS head=$HEAD $BB=$DEV"
exit $rc
