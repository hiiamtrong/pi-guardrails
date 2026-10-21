#!/bin/bash
# gate_comments.sh <PR> <draft.md> [AS_OF MM-DDTHH:MM UTC, replay only]; SEEN=<file> also checks the guard's .seen.
# #19233: the old guard filtered bots out, so the bot inline that predated the approve was never read.
set -u
N=$1; DRAFT=$2; AS_OF=${3:-}
[ -n "${RV:-}" ] || { f="$(dirname "$0")/../.pipeline-env"; [ ! -f "$f" ] || . "$f"; }  # run by hand: the /review-pr extension wrote the environment next to the tools
RV=${RV:?set RV}
[ -f "${HANDBOOK:-}" ] || { echo "ABORT: set RV, HANDBOOK and REVIEWER (the /review-pr extension does)" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
ERR=$(mktemp)
LIVE=$("$RV/reports/reviews/tools/comments_seen.sh" "$N") || { echo "COMMENTS: ABORT không đọc được comment của #$N"; exit 2; }
[ -n "$AS_OF" ] && LIVE=$(printf '%s\n' "$LIVE" | awk -F'\t' -v t="$AS_OF" '{ split($2, a, " "); if (substr(a[1], 1, 11) <= t) print }')
echo "COMMENTS: $(printf '%s\n' "$LIVE" | grep -c .) comment/review trên GitHub${AS_OF:+ tính đến $AS_OF UTC}"
TABLE=$(python3.12 "$HERE/seen_from_table.py" "$DRAFT" 2>"$ERR"); TRC=$?
sed 's/^/  /' "$ERR"; rm -f "$ERR"
rc=0
[ $TRC -eq 0 ] || { echo "COMMENTS: FAIL bảng chưa hợp lệ"; rc=1; }
MISSING=$(printf '%s\n' "$LIVE" | grep . | while IFS= read -r line; do printf '%s\n' "$TABLE" | grep -qxF "${line%%$'\t'*}" || printf '%s\n' "$line"; done)
if [ -n "$MISSING" ]; then
  echo "COMMENTS: FAIL chưa có trong bảng:"; printf '%s\n' "$MISSING" | cut -c1-150 | sed 's/^/  /'; rc=1
fi
# A .seen dumped with `comments_seen.sh --ids` lists unread comments too and turns the post guard green.
if [ -n "${SEEN:-}" ]; then
  if [ "$(LC_ALL=C sort "$SEEN")" = "$TABLE" ]; then echo "COMMENTS: .seen trùng bảng"; else echo "COMMENTS: FAIL $SEEN khác id trong bảng"; rc=1; fi
fi
[ $rc -eq 0 ] && echo "COMMENTS: PASS mọi id đã xếp loại"
exit $rc
