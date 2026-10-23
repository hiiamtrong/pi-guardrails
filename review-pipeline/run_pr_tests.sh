#!/bin/sh
# Run pytest on a PR head without rebuilding the image: mount the PR worktree's
# swag/, tests/ and libs/ read-only over the compose `api` image.
# Usage: reports/reviews/tools/run_pr_tests.sh <PR or worktree path> <pytest args...>
# Setup: git fetch origin pull/<PR>/head:refs/remotes/pr/<PR>
#        git worktree add --detach ../swag-pr-<PR> refs/remotes/pr/<PR>
# Only valid while the dependency diff between the image and the PR is trivial.
# EXTRA_DOCKER_ARGS adds docker options, e.g. EXTRA_DOCKER_ARGS="-v $WT/deploy:/usr/src/app/deploy:ro" for tests that read deploy/.
PR=$1; shift
T=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$T/../../.." && pwd)
WT="$(dirname "$REPO")/swag-pr-$PR"
[ -d "$PR" ] && WT=$(cd "$PR" && pwd)
[ -d "$WT" ] || { echo "no worktree at $WT" >&2; exit 1; }
cd "$REPO"
# Every run shares the swag_test databases and redis db 15, so two PRs testing at once would corrupt each other: take turns.
# The lock is a link to our pid (ln -s is atomic). A lock whose pid is gone, or now belongs to some other process (pids are reused after a reboot), is taken over.
# shortcut: two waiters taking over the same stale lock can both run; waiting stops after TESTS_LOCK_WAIT seconds (default 30 min).
[ -f "$REPO/compose.yaml" ] || { echo "no compose.yaml in $REPO: run the script from reports/reviews/tools of the review checkout" >&2; exit 2; }
LOCK="$REPO/reports/reviews/.tests.lock"
trap 'exit 1' INT TERM HUP
trap '[ "$(readlink "$LOCK")" != "$$" ] || rm -f "$LOCK"' EXIT
waited=0; blind=0
while ! ln -s "$$" "$LOCK" 2>/dev/null; do
  holder=$(readlink "$LOCK")
  # ln failed but no link to read: a holder that vanished between the two calls, or something that is not our link at that path.
  [ -n "$holder" ] || { blind=$((blind + 1)); [ "$blind" -lt 5 ] || { echo "ABORT: không tạo được khoá $LOCK (có file lạ ở đó?)" >&2; exit 2; }; sleep 1; continue; }
  if ps -p "$holder" -o command= 2>/dev/null | grep -q run_pr_tests.sh; then
    [ "$waited" -gt 0 ] || echo "đợi lượt chạy test: pid $holder đang chạy (mọi PR dùng chung DB test)" >&2
    [ "$waited" -lt "${TESTS_LOCK_WAIT:-1800}" ] || { echo "ABORT: đợi quá ${TESTS_LOCK_WAIT:-1800}s, pid $holder vẫn giữ $LOCK: dừng nó hoặc xoá khoá rồi chạy lại" >&2; exit 2; }
    waited=$((waited + 1))
    sleep 1
  else
    rm -f "$LOCK"
  fi
done
# compose.review.yaml mounts the checkout read-only and gives /tmp to the run alone: the PR's tests cannot touch the evidence the gates read.
docker compose -f "$REPO/compose.yaml" -f "$T/compose.review.yaml" --project-directory "$REPO" run --rm -T \
  -v "$WT/swag:/usr/src/app/swag:ro" -v "$WT/tests:/usr/src/app/tests:ro" -v "$WT/libs:/usr/src/app/libs:ro" \
  ${EXTRA_DOCKER_ARGS:-} \
  -e MONGO_URL=mongodb://mongos:27018/swag_test \
  -e POSTGRES_URL=postgresql+psycopg://swag:swag@postgres:5432/swag_test \
  -e REDIS_URL=redis://redis:6379/15 \
  -e SWAG_RUNNING_IN_TESTS=1 -e PYTHONOPTIMIZE=0 -e HOME=/tmp -e PROBE_LABEL \
  --entrypoint "" api sh -c "
    pip install -q pytest pytest-flask pytest-mock pytest-forked >/dev/null 2>&1
    PYTHONPATH=/usr/src/app:/tmp/.local/lib/python3.12/site-packages python -m pytest -q -s -p no:cacheprovider -rfE $*
  " 2>&1 | grep -E "passed|failed|error|FAILED|ERROR|Error|assert|R[0-9]+::" | grep -v "Warning\|warn(" | tail -25
