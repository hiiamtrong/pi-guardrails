# Post guard template. Instantiate by replacing __REPO__ (owner/name) __REVIEWER__ (GitHub login) __PR__ __DRAFT__ __DEV10__ __EVENT__ __FILES__ __DESC_SHA16__ and copy to /tmp/rv/post/<draft>-guard.sh.
# __DESC_SHA16__ is `shasum -a 256 <description file> | cut -c1-16` of `gh api repos/<repo>/pulls/<N> --jq .body` (raw bytes: a description written on the web has CRLF line ends).
# Needs <POST_DIR>/<draft>.review.json, .approved.sha256 and .seen written by `seen_from_table.py <draft>.md` (never `comments_seen.sh --ids`).
# Stop cases to run before use: unseen comment, bot-only unseen comment, wrong event, description changed, other token, payload not the pin, develop on the watchlist, file list changed, API error, head moved.
set -u
POST_DIR=${POST_DIR:-/tmp/rv/post}; OUT=${OUT:-$POST_DIR}
cd "$POST_DIR"
export GH_TOKEN="$(gh auth token -h github.com -u __REVIEWER__)"
R=__REPO__; N=__PR__; D=__DRAFT__; VERIFIED_DEV=__DEV10__; EXPECTED_EVENT=__EVENT__
RV=${RV:?set RV to the review checkout}
V2=${V2:-$RV/reports/reviews/tools/v2}
PRFILES='__FILES__'
WATCH='^(swag/migration/|deploy/chat-backfill/|swag/db/|alembic/|swag/settings/|swag/__init__\.py$|swag/utils/|tests/(integration/)?migration/|tests/(integration/)?(features/)?conftest\.py$|tests/conftest\.py$|\.pre-commit-config\.yaml$)'
fail() { echo "ABORT: $*"; exit 1; }
lines() { printf '%s\n' "$1" | grep -c .; }
HEAD=$(python3.12 -c "import json; print(json.load(open('$D.review.json'))['commit_id'])") || fail "could not read the payload"
EVENT=$(python3.12 -c "import json; print(json.load(open('$D.review.json'))['event'])") || fail "could not read the payload"
LOGIN=$(gh api user --jq .login) || fail "could not read the user"
[ "$LOGIN" = "__REVIEWER__" ] || fail "token is not __REVIEWER__'s"
[ "$EVENT" = "$EXPECTED_EVENT" ] || fail "event is $EVENT, expected $EXPECTED_EVENT"
STATE=$(gh api repos/$R/pulls/$N --jq '"\(.state) \(.merged) \(.head.sha) \(.base.ref)"') || fail "could not read the PR"
read -r PR_STATE PR_MERGED PR_HEAD PR_BASE <<<"$STATE"
[ "$PR_STATE $PR_MERGED $PR_HEAD" = "open false $HEAD" ] || fail "PR state changed: $STATE"
"$V2/check_base.sh" "$R" "$N" "$PR_BASE" >/dev/null || fail "PR base is $PR_BASE: not develop, and not the open branch of a parent PR named under PR Dependencies"
FILES=$(gh api --paginate "repos/$R/pulls/$N/files?per_page=100" --jq '.[].filename') || fail "could not list the PR's files"
[ "$(printf '%s\n' "$FILES" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" = "$PRFILES" ] || fail "the PR's file list changed: $(printf '%s' "$FILES" | tr '\n' ' ')"
DEV=$(gh api repos/$R/branches/develop --jq .commit.sha) || fail "could not read develop"
[[ "$DEV" =~ ^[0-9a-f]{40}$ ]] || fail "unexpected develop sha: $DEV"
if [ "${DEV:0:10}" != "$VERIFIED_DEV" ]; then
  MOVED=$(gh api "repos/$R/compare/$VERIFIED_DEV...$DEV" --jq '.files[].filename') || fail "could not compare develop ${DEV:0:10} with $VERIFIED_DEV"
  count=$(lines "$MOVED")
  [ "$count" -gt 0 ] && [ "$count" -lt 300 ] || fail "develop moved by $count files, outside what the compare API lists in full"
  hits=$(printf '%s\n' "$MOVED" | grep -E "$WATCH" | tr '\n' ' ')
  [ -z "$hits" ] || fail "develop moved to ${DEV:0:10} and touched the watchlist: $hits"
  echo "develop moved to ${DEV:0:10} ($count files), none on the watchlist"
fi
gh api repos/$R/pulls/$N --jq '.body' > $OUT/$D-desc.txt || fail "could not read the description"
[ "$(python3.12 -c "import hashlib; print(hashlib.sha256(open('$OUT/$D-desc.txt','rb').read()).hexdigest()[:16])")" = "__DESC_SHA16__" ] || fail "description changed, point 6 relies on it"
# #19233: a .seen dumped from the live list made this check pass for comments nobody had read.
[ -f $D.seen ] || fail "no $D.seen"
[ "$(python3.12 $V2/seen_from_table.py $RV/reports/reviews/$D.md)" = "$(LC_ALL=C sort $D.seen)" ] || fail "$D.seen is not the draft's Comment table"
DRAFT=$RV/reports/reviews/$D.md WORK=$OUT/$D-status $V2/pipeline_status.sh $N > $OUT/$D-status.txt 2>&1 || fail "pipeline_status is red: $(grep -E ' (FAIL|ABORT) ' $OUT/$D-status.txt | cut -c1-20 | tr '\n' ' ')"
# Every review and comment on the PR, bots included, must be in the list written after reading and classifying them in the draft's "Comment đã có".
UNSEEN=$($RV/reports/reviews/tools/comments_seen.sh $N --unseen $POST_DIR/$D.seen); rc=$?
[ $rc -eq 0 ] || fail "comments not in the draft (rc=$rc): $(printf '%s' "$UNSEEN" | cut -c1-200 | tr '\n' '|')"
shasum -a 256 -c $D.approved.sha256 > /dev/null || fail "payload differs from the approved text"
echo "guards passed at $(TZ=Asia/Ho_Chi_Minh date '+%H:%M:%S') ICT (head ${HEAD:0:10}, develop ${DEV:0:10}, pin $(cut -c1-16 $D.approved.sha256))"
