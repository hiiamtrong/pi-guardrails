#!/bin/sh
# Run pytest on a PR head without rebuilding the image: mount the PR worktree's
# swag/, tests/ and libs/ read-only over the compose `api` image.
# Usage: reports/reviews/tools/run_pr_tests.sh <PR or worktree path> <pytest args...>
# Setup: git fetch origin pull/<PR>/head:refs/remotes/pr/<PR>
#        git worktree add --detach ../swag-pr-<PR> refs/remotes/pr/<PR>
# Only valid while the dependency diff between the image and the PR is trivial.
# EXTRA_DOCKER_ARGS adds docker options, e.g. EXTRA_DOCKER_ARGS="-v $WT/deploy:/usr/src/app/deploy:ro" for tests that read deploy/.
PR=$1; shift
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
WT="$(dirname "$REPO")/swag-pr-$PR"
[ -d "$PR" ] && WT=$(cd "$PR" && pwd)
[ -d "$WT" ] || { echo "no worktree at $WT" >&2; exit 1; }
cd "$REPO"
docker compose run --rm -T \
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
