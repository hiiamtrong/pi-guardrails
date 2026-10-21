#!/bin/bash
# after_post.sh <PR> <draft.md>   Jason's Request changes landed 4 minutes after the #19233 approve; an approve cannot
# be withdrawn, so this only makes the next action (new review, -r<N>b.md draft) start from facts.
set -u
N=$1; DRAFT=$2
[ -n "${RV:-}" ] || { f="$(dirname "$0")/../.pipeline-env"; [ ! -f "$f" ] || . "$f"; }  # run by hand: the /review-pr extension wrote the environment next to the tools
RV=${RV:?set RV}
[ -f "${HANDBOOK:-}" ] || { echo "ABORT: set RV, HANDBOOK and REVIEWER (the /review-pr extension does)" >&2; exit 2; }
REPO=${REPO:?set REPO (owner/name)}
HERE=$(cd "$(dirname "$0")" && pwd)
export GH_TOKEN="$(gh auth token -h github.com -u "$REVIEWER")" || exit 2
SEEN=$(mktemp)
python3.12 "$HERE/seen_from_table.py" "$DRAFT" > "$SEEN" 2>/dev/null || echo "AFTER: WARN   bảng Comment đã có chưa hợp lệ (chạy gate_comments.sh để xem)"
rc=0
UNSEEN=$("$RV/reports/reviews/tools/comments_seen.sh" "$N" --unseen "$SEEN"); urc=$?
if [ $urc -eq 0 ]; then echo "AFTER: PASS   không có comment mới ngoài bảng"; else echo "AFTER: FAIL   có comment chưa đọc (rc=$urc):"; printf '%s\n' "$UNSEEN" | cut -c1-150 | sed 's/^/  /'; rc=1; fi
# Edits keep the id, so an id-only .seen cannot see a comment rewritten after it was classified.
EDITED=$(gh api --paginate "repos/$REPO/pulls/$N/comments?per_page=100" --jq '.[] | select(((.updated_at|fromdate) - (.created_at|fromdate)) > 60 and .user.login != "'"$REVIEWER"'") | "inline:\(.id) sửa lúc \(.updated_at) (tạo \(.created_at))"')
[ -n "$EDITED" ] && { echo "AFTER: WARN   comment đã bị sửa sau khi tạo, đọc lại:"; printf '%s\n' "$EDITED" | sed 's/^/  /'; }
HEAD=$(gh api "repos/$REPO/pulls/$N" --jq .head.sha)
gh api --paginate "repos/$REPO/pulls/$N/reviews?per_page=100" --jq '.[] | select(.user.login=="'"$REVIEWER"'") | "\(.id) \(.state) \(.commit_id) \(.submitted_at)"' | while read -r id st sha at; do
  [ "$sha" = "$HEAD" ] && note="trên head hiện tại" || note="head đã đổi (${HEAD:0:10}): approve có thể đã bị dismiss"
  echo "AFTER: INFO   review $id $st trên ${sha:0:10} lúc $at, $note"
done
# reviewDecision exists only in GraphQL, which is a POST; this tool stays GET-only.
echo "AFTER: INFO   PR $(gh api "repos/$REPO/pulls/$N" --jq '"\(.state) merged=\(.merged)"')"
rm -f "$SEEN"
exit $rc
