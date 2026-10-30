#!/bin/bash
# check_head.sh <PR>   exit 5 when the PR head on GitHub is no longer the one gate 00 recorded in $WORK/head.sha, else 0.
# The author pushed while a runner was still working: every later step would be judged against a head nobody reviewed.
# A check that cannot ask GitHub (no network, no token) or has no recorded head says nothing instead of stopping the review.
set -u
N=$1
[ -n "${RV:-}" ] || { f="$(dirname "$0")/../.pipeline-env"; [ ! -f "$f" ] || . "$f"; }  # run by hand: the /review-pr extension wrote the environment next to the tools
WORK=${WORK:-${RV:?set RV}/reports/reviews/evidence/$N/gates}
[ -s "$WORK/head.sha" ] || exit 0
REPO=${REPO:?set REPO (owner/name)}
TOKEN=$(gh auth token -h github.com -u "${REVIEWER:?set REVIEWER}" 2>/dev/null) || exit 0
NOW=$(GH_TOKEN=$TOKEN gh api "repos/$REPO/pulls/$N" --jq .head.sha 2>/dev/null) || exit 0
[ -n "$NOW" ] || exit 0
THEN=$(cat "$WORK/head.sha")
[ "$NOW" != "$THEN" ] || exit 0
echo "HEAD_MOVED: PR #$N đổi head từ ${THEN:0:10} sang ${NOW:0:10} khi review đang chạy: dừng, đừng làm tiếp trên head cũ. Báo người dùng rồi chạy lại từ bước 00 (cập nhật refs/remotes/pr/$N và worktree trước)." >&2
exit 5
