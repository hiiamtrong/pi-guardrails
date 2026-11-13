# Functions of run_review.sh that have a test of their own (test_agent.py). Source this file; it runs nothing.

# checkout <dir> <url> <reviewer> <branch>
# The handbook (AGENTS.local.md or AGENTS.md) is untracked and may already sit in <dir>: a clone or a git clean would lose it.
# Two Jobs of one project start in the same second and share <dir>, so the work is serialized on a lock file beside it (git's own
# config and index locks make the second Job fail instead of wait).
checkout() {
  mkdir -p "$(dirname "$1")"
  (
    flock 9
    mkdir -p "$1"
    [ -d "$1/.git" ] || git -C "$1" init -q
    git -C "$1" remote set-url origin "$2" 2>/dev/null || git -C "$1" remote add origin "$2"
    git -C "$1" config identity.guard.user "$3"
    git -C "$1" fetch -q --filter=blob:none origin "+refs/heads/$4:refs/remotes/origin/$4"
    git -C "$1" checkout -q -f --detach "origin/$4"
  ) 9> "$1.lock"
}

# remove_pr_worktrees <checkout dir> <PR>
# The PR's worktree is only needed while the review runs: the draft and the evidence live under reports/, and the volume is small.
remove_pr_worktrees() {
  { git -C "$1" worktree list --porcelain | sed -n 's/^worktree //p' | grep -E -- "-pr-$2\$" || true; } | while read -r worktree; do
    git -C "$1" worktree remove --force "$worktree"
  done
  git -C "$1" worktree prune
}
