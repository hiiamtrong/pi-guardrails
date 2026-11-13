#!/bin/bash
# poll.sh <project>   Starts one review Job for each PR of the project that needs one (CronJob entry point).
# The first poll of a project has no state file yet and only records what is open (auto_pick.py --baseline), so turning the poller on does not review every old PR.
set -eu -o pipefail
NAME=${1:?project}
CFG=${PROJECTS:-/etc/review/projects.json}
field() { jq -r --arg n "$NAME" --arg k "$1" '.[$n][$k] // empty' "$CFG"; }
REPO=$(field repo); REVIEWER=$(field reviewer); TOKEN_VAR=$(field tokenVar); DIR=$(field dir)
[ -n "$REPO" ] || { echo "ABORT: không có project '$NAME' trong $CFG" >&2; exit 2; }
[ -n "${!TOKEN_VAR:-}" ] || { echo "ABORT: $TOKEN_VAR trống: secret agent-secrets thiếu token GitHub chỉ đọc của $REVIEWER" >&2; exit 3; }

RULES=$HOME/.pi/agent/review-pipeline/projects/$(printf %s "$DIR" | tr / -)
PATTERN=$(jq -r '.authorPattern // empty' "$RULES/pipeline.json")
STATE=$HOME/.pi/agent/review-pipeline/state/$NAME.json
[ -f "$STATE" ] || BASELINE=--baseline

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
# The board exits 1 when some PR could not be read but still prints the rows it could: pick from those, and report the failure at the end.
env GH_TOKEN="${!TOKEN_VAR}" python3.12 "$ENGINE/v2/review_board.py" --json --repo "$REPO" --reviewer "$REVIEWER" ${PATTERN:+--author-pattern "$PATTERN"} > board.json || BOARD_RC=$?
SHORT=$(printf %s "$NAME" | tr -c 'a-z0-9' - | cut -c1-20 | sed 's/-*$//')
python3.12 "$ENGINE/v2/auto_pick.py" --state "$STATE" --settle "${SETTLE:-10}" --limit "${LIMIT:-2}" ${BASELINE:-} < board.json | while read -r PR; do
  JOB=rv-$SHORT-$PR-$(date +%s)
  if sed -e "s|__JOB__|$JOB|g" -e "s|__PROJECT__|$NAME|g" -e "s|__PR__|$PR|g" -e "s|__TOKEN_VAR__|$TOKEN_VAR|g" -e "s|__MODEL__|router|g" "${JOB_TEMPLATE:-/opt/agent/job.yaml}" | kubectl create -f -; then
    echo "poll: $NAME #$PR -> $JOB"
  else
    # auto_pick.py already recorded the PR; forget it so the next poll tries again.
    jq --arg n "$PR" 'del(.[$n])' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
    echo "poll: không tạo được Job cho $NAME #$PR" >&2
  fi
done
exit "${BOARD_RC:-0}"
