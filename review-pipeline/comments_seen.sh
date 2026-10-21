#!/bin/bash
# Every review, inline and conversation comment on a PR, bots included, except Theo's own.
# Usage: comments_seen.sh <PR>                  readable list
#        comments_seen.sh <PR> --ids            sorted "kind:id" lines (write them to /tmp/rv/post/<draft>.seen once each is read and classified in the draft)
#        comments_seen.sh <PR> --unseen FILE    readable lines whose id is not in FILE; exit 1 if any (used by the post guard and the after-post recheck)
# Reads as Theo through a pinned token; never switches the shared gh account.
set -u
N=$1; MODE=${2:-}; FILE=${3:-}
[ -n "${RV:-}" ] || { f="$(dirname "$0")/.pipeline-env"; [ ! -f "$f" ] || . "$f"; }  # run by hand: the /review-pr extension wrote the environment next to the tools
R=${REPO:?set REPO (owner/name)}
export GH_TOKEN="$(gh auth token -h github.com -u "${REVIEWER:?set REVIEWER}")" || { echo "ABORT: no token for $REVIEWER" >&2; exit 2; }
ME=$REVIEWER
all() {
  gh api --paginate "repos/$R/pulls/$N/reviews?per_page=100" --jq ".[] | select(.user.login!=\"$ME\" and .state!=\"PENDING\") | \"review:\(.id)\t\(.submitted_at[5:16])Z \(.user.login) (\(.user.type)) \(.state) on \(.commit_id[0:10]) :: \(.body[0:200]|gsub(\"\\n\";\" \"))\"" || exit 2
  gh api --paginate "repos/$R/pulls/$N/comments?per_page=100" --jq ".[] | select(.user.login!=\"$ME\") | \"inline:\(.id)\t\(.created_at[5:16])Z \(.user.login) (\(.user.type)) \(.path|split(\"/\")|last):\(.line // .original_line) :: \(.body[0:200]|gsub(\"\\n\";\" \"))\"" || exit 2
  gh api --paginate "repos/$R/issues/$N/comments?per_page=100" --jq ".[] | select(.user.login!=\"$ME\") | \"conv:\(.id)\t\(.created_at[5:16])Z \(.user.login) (\(.user.type)) :: \(.body[0:200]|gsub(\"\\n\";\" \"))\"" || exit 2
}
OUT=$(all) || { echo "ABORT: could not list comments of #$N" >&2; exit 2; }
case "$MODE" in
  --ids) printf '%s\n' "$OUT" | grep . | cut -f1 | LC_ALL=C sort ;;
  --unseen)
    [ -f "$FILE" ] || { echo "ABORT: no seen file $FILE" >&2; exit 2; }
    UN=$(printf '%s\n' "$OUT" | grep . | while IFS= read -r line; do grep -qxF "${line%%$'\t'*}" "$FILE" || printf '%s\n' "$line"; done)
    [ -z "$UN" ] && exit 0; printf '%s\n' "$UN"; exit 1 ;;
  *) printf '%s\n' "$OUT" | grep . | LC_ALL=C sort -t: -k2 ;;
esac
