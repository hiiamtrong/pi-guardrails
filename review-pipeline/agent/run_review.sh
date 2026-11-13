#!/bin/bash
# run_review.sh <project> <PR>   One unattended review of a PR, steps 00 to 05, inside the agent pod. The project's GitHub token and a model credential come from the environment.
set -eu
NAME=${1:?project}; PR=${2:?PR}
case "$PR" in ''|*[!0-9]*) echo "ABORT: PR phải là số, nhận được '$PR'" >&2; exit 2 ;; esac
CFG=${PROJECTS:-/etc/review/projects.json}
field() { jq -r --arg n "$1" --arg k "$2" '.[$n][$k] // empty' "$CFG"; }
REPO=$(field "$NAME" repo); REVIEWER=$(field "$NAME" reviewer); TOKEN_VAR=$(field "$NAME" tokenVar); DIR=$(field "$NAME" dir)
[ -n "$REPO" ] && [ -n "$DIR" ] || { echo "ABORT: không có project '$NAME' trong $CFG" >&2; exit 2; }
[ -n "${!TOKEN_VAR:-}" ] || { echo "ABORT: $TOKEN_VAR trống: secret agent-secrets thiếu token GitHub chỉ đọc của $REVIEWER" >&2; exit 3; }
# The pod's router sends every tier to opencode-go (auto-router.json next to this script), so only that key is required; the Claude login is used
# when a tier names claude-bridge or when MODEL pins one.
MODEL=${MODEL:-router}
case "$MODEL" in *__*) echo "WARN: MODEL chưa được điền ($MODEL), dùng router" >&2; MODEL=router ;; esac
case "$MODEL" in
  *claude-bridge*) [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${CLAUDE_CREDENTIALS_B64:-}" ] || { echo "ABORT: $MODEL cần CLAUDE_CODE_OAUTH_TOKEN hoặc CLAUDE_CREDENTIALS_B64 trong secret agent-secrets" >&2; exit 3; } ;;
esac
if [ "$MODEL" = router ] || [ "${MODEL%%/*}" = opencode-go ]; then
  [ -n "${OPENCODE_API_KEY:-}" ] || { echo "ABORT: $MODEL cần OPENCODE_API_KEY trong secret agent-secrets" >&2; exit 3; }
  # An expired key fails every turn with a bare 401 half an hour in; refuse it now, before a pod is wasted.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "Authorization: Bearer $OPENCODE_API_KEY" https://opencode.ai/inference/go/openai/v1/models || true)
  case "$code" in
    200) ;;
    401|403) echo "ABORT: OPENCODE_API_KEY bị từ chối ($code): tạo key mới ở https://opencode.ai/console/account#api-keys rồi chạy set-secrets.sh" >&2; exit 3 ;;
    *) echo "WARN: không kiểm được OPENCODE_API_KEY (HTTP $code), vẫn chạy" >&2 ;;
  esac
fi
# The login the Mac already has, written once onto the volume (base64, so no quoting can break it): the CLI renews it there from then on.
export CLAUDE_CONFIG_DIR=$HOME/.claude
if [ -n "${CLAUDE_CREDENTIALS_B64:-}" ] && [ ! -s "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR"
  ( umask 077; printf %s "$CLAUDE_CREDENTIALS_B64" | base64 -d > "$CLAUDE_CONFIG_DIR/.credentials.json" )
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$CLAUDE_CONFIG_DIR/.credentials.json" 2>/dev/null \
    || { echo "ABORT: CLAUDE_CREDENTIALS_B64 không giải mã ra JSON" >&2; exit 3; }
  echo "auth: đã ghi login của claude vào $CLAUDE_CONFIG_DIR/.credentials.json" >&2
fi
# An account file left by an older image makes the CLI refuse the login, so a broken one goes.
if [ -s "$CLAUDE_CONFIG_DIR/.claude.json" ] && ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$CLAUDE_CONFIG_DIR/.claude.json" 2>/dev/null; then rm -f "$CLAUDE_CONFIG_DIR/.claude.json"; fi

# The scout subagent is opencode-go in the reviewer's settings.json too.
[ -n "${OPENCODE_API_KEY:-}" ] || echo "WARN: OPENCODE_API_KEY trống: subagent scout (opencode-go) sẽ lỗi" >&2
# The Mac's auto-router.json mixes claude-bridge into light and heavy; the pod's copy keeps every tier on opencode, whose plan is separate.
export PI_AUTO_ROUTER_CONFIG=/opt/agent/auto-router.json

# A classic token with `repo` can write, so the pod could post even though it must not: the guards only stop its own gh calls.
scopes=$(gh api -i user 2>/dev/null | tr -d '\r' | sed -n 's/^x-oauth-scopes: //Ip')
case "$scopes" in *repo*|*write*) echo "WARN: token của $REVIEWER có quyền ghi ($scopes): thay bằng fine-grained chỉ đọc để pod không thể post" >&2 ;; esac

# The review gates read the reviewer's token with `gh auth token -u`, which only reads this file. `gh auth login --with-token` is not used: it
# refuses a token without read:org and gist, which a read-only token for these three repos does not need.
export GH_CONFIG_DIR=/tmp/gh
mkdir -p "$GH_CONFIG_DIR" && umask 077
printf 'github.com:\n    user: %s\n    oauth_token: %s\n    git_protocol: https\n    users:\n        %s:\n            oauth_token: %s\n' \
  "$REVIEWER" "${!TOKEN_VAR}" "$REVIEWER" "${!TOKEN_VAR}" > "$GH_CONFIG_DIR/hosts.yml"
gh auth setup-git --hostname github.com
[ "$(gh auth token -u "$REVIEWER" 2>/dev/null)" = "${!TOKEN_VAR}" ] || { echo "ABORT: không đọc lại được token của $REVIEWER từ $GH_CONFIG_DIR/hosts.yml" >&2; exit 3; }
unset GH_TOKEN GITHUB_TOKEN
# pi-claude-bridge: an exported ANTHROPIC_* variable redirects its Claude Code child and every turn then fails.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_OAUTH_TOKEN

KEY=$(printf %s "$DIR" | tr / -)
RULES=$HOME/.pi/agent/review-pipeline/projects/$KEY
[ -d "$RULES/steps" ] || { echo "ABORT: chưa có rules ở $RULES" >&2; exit 3; }
BASE=$(jq -r '.baseBranch // "develop"' "$RULES/pipeline.json")

. "$(dirname "$0")/lib.sh"
checkout "$DIR" "https://github.com/$REPO.git" "$REVIEWER" "$BASE"
for need in $(jq -r --arg n "$NAME" '.[$n].needs // [] | .[]' "$CFG"); do
  checkout "$(field "$need" dir)" "https://github.com/$(field "$need" repo).git" "$(field "$need" reviewer)" "$(jq -r '.baseBranch // "develop"' "$HOME/.pi/agent/review-pipeline/projects/$(field "$need" dir | tr / -)/pipeline.json")"
done

EVID=$DIR/reports/reviews/evidence/$PR
mkdir -p "$EVID"
URL=https://github.com/$REPO/pull/$PR
PROMPT="Review $URL without anyone watching. Call the review_start tool with link=$URL and background=false, then follow its kickoff with review_step through step 05 and stop there. The unattended-run rules appended to your system prompt apply."
cd "$DIR"
set +e
timeout "${RV_AGENT_TIMEOUT:-4800}" pi -p --model "$MODEL" --append-system-prompt /opt/agent/AGENTS.md "$PROMPT" 2>&1 | tee "$EVID/agent.log"
RC=${PIPESTATUS[0]}
set -e

# Red gates are the normal outcome the human reads, so the table is recorded whatever its exit code.
{
  echo "project=$NAME pr=$PR rc=$RC finished=$(date -u +%FT%TZ)"
  "$DIR/reports/reviews/tools/v2/pipeline_status.sh" "$PR" 2>&1 || true
} > "$EVID/auto-status.txt"
remove_pr_worktrees "$DIR" "$PR"
find "$HOME/.pi/agent/sessions" -type f -mtime +14 -delete
exit "$RC"
