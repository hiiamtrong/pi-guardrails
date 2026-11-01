#!/bin/bash
# Run reports/reviews/tools/run_pr_tests.sh unchanged, but keep pytest's exit code: the original pipes through
# grep | tail, so rc 5 (no test collected) or rc 4 (bad node id) prints nothing and exits 0 (replay/rc-loss.txt).
# The trailing "; echo R0::..." rides inside the container's sh -c "... $*", and R[0-9]+:: survives its output filter.
# Usage: run_tests_rc.sh <PR|worktree> <pytest args...>   (append to an evidence log with: | tee -a <log>)
# Exit: pytest's rc; 3 if no rc line came back (the run is void, do not read it).
# On k3s the PR's pod is kept between runs (databases included): RV_FRESH_POD=1 gives this run a throwaway pod with empty databases.
[ -n "${RV:-}" ] || { f="$(dirname "$0")/../.pipeline-env"; [ ! -f "$f" ] || . "$f"; }  # run by hand: the /review-pr extension wrote the environment next to the tools
RV=${RV:?set RV}
[ -f "${HANDBOOK:-}" ] || { echo "ABORT: set RV, HANDBOOK and REVIEWER (the /review-pr extension does)" >&2; exit 2; }
export DOCKER_HOST=${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}
# The arguments go through sh -c "... $*", which splits words: -k "a or b" would become -k a or b and pytest would exit 4.
for arg in "${@:2}"; do
  case "$arg" in *[[:space:]]*) echo "ABORT: argument with spaces ($arg): the wrapper splits words, use a one-word -k or node ids" >&2; exit 2;; esac
done
OUT=$("$RV/reports/reviews/tools/run_pr_tests.sh" "$@" '; echo R0::pytest_rc=$?')
printf '%s\n' "$OUT"
RC=$(printf '%s\n' "$OUT" | sed -n 's/.*R0::pytest_rc=\([0-9][0-9]*\).*/\1/p' | tail -1)
[ -n "$RC" ] || { echo "pytest_rc=VOID (no rc line)"; exit 3; }
echo "pytest_rc=$RC"
exit "$RC"
