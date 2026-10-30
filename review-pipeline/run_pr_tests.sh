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
# REVIEW_ENV=k3s (the default once pipeline.json names a "k3sHost") runs the tests in a pod of their own on the k3s node: its own databases,
# no shared lock, nothing left behind (see k3s/rv_k3s.sh). REVIEW_ENV=local keeps the compose stack on this machine, shared and one run at a time.
[ -n "${K3S_SSH:-}" ] || { [ ! -f "$T/.pipeline-env" ] || K3S_SSH=$(. "$T/.pipeline-env" >/dev/null 2>&1; printf %s "${K3S_SSH:-}"); export K3S_SSH; }  # read in a subshell: the file also sets REPO, which this script uses for the checkout path
if [ "${REVIEW_ENV:-$([ -n "${K3S_SSH:-}" ] && echo k3s || echo local)}" = k3s ]; then
  [ -z "${EXTRA_DOCKER_ARGS:-}" ] || echo "cảnh báo: EXTRA_DOCKER_ARGS không dùng với k3s, cả worktree đã được chép lên pod" >&2
  N=$(printf '%s' "$PR" | grep -oE '[0-9]+$' | tail -1)
  RCF=$(mktemp)
  # The driver's own messages go to stderr; only the pod's output passes the same filter as the local run. Its status is kept apart because the pipe loses it.
  { "$T/k3s/rv_k3s.sh" run swag-server "${N:-0}" "$WT" "${PROBE_LABEL:+export PROBE_LABEL='$PROBE_LABEL'; }python -m pytest -q -s -p no:cacheprovider -rfE $*"; echo $? > "$RCF"; } \
    | grep -E "passed|failed|error|FAILED|ERROR|Error|assert|R[0-9]+::" | grep -v "Warning\|warn(" | tail -25
  rc=$(cat "$RCF"); rm -f "$RCF"
  case "$rc" in 123|124|125) exit "$rc" ;; esac  # 123 head moved, 124 timeout, 125 the node or pod could not be used; anything else is pytest's, which the caller reads from the output
  exit 0
fi
# Every run shares the swag_test databases and redis db 15, so two PRs testing at once would corrupt each other: take turns.
# The lock is a link to our pid (ln -s is atomic). A lock whose pid is gone, or now belongs to some other process (pids are reused after a reboot), is taken over.
# shortcut: two waiters taking over the same stale lock can both run; waiting stops after TESTS_LOCK_WAIT seconds (default 30 min).
# The time in the queue is not the time of the run: TESTS_RUN_TIMEOUT (default 25 min) starts only once the lock is ours, and a run over it
# is killed with its container (exit 124), so a hung test cannot keep the databases and the lock until someone notices.
[ -f "$REPO/compose.yaml" ] || { echo "no compose.yaml in $REPO: run the script from reports/reviews/tools of the review checkout" >&2; exit 2; }
LOCK="$REPO/reports/reviews/.tests.lock"
CNAME="rvtest-$$"
TIMEOUT_FLAG="$REPO/reports/reviews/.tests.timeout-$$"
trap 'exit 1' INT TERM HUP
trap '[ -z "${WATCH:-}" ] || { pkill -P "$WATCH" 2>/dev/null; kill "$WATCH" 2>/dev/null; }; docker rm -f "$CNAME" >/dev/null 2>&1; rm -f "$TIMEOUT_FLAG"; [ "$(readlink "$LOCK")" != "$$" ] || rm -f "$LOCK"' EXIT
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
# && so that killing the sleep (the run ended in time) cancels the rest
( sleep "${TESTS_RUN_TIMEOUT:-1500}" && { : > "$TIMEOUT_FLAG"; docker rm -f "$CNAME" >/dev/null 2>&1; } ) &
WATCH=$!
docker compose -f "$REPO/compose.yaml" -f "$T/compose.review.yaml" --project-directory "$REPO" run --rm -T --name "$CNAME" \
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
pkill -P "$WATCH" 2>/dev/null; kill "$WATCH" 2>/dev/null
[ ! -e "$TIMEOUT_FLAG" ] || { echo "ABORT: test chạy quá ${TESTS_RUN_TIMEOUT:-1500}s (không tính thời gian đợi khoá), đã dừng container $CNAME" >&2; exit 124; }
