#!/bin/bash
# check-tokens.sh [file]   What each token can do, without printing any of them: the login it resolves to, its scopes, and one read of a private repo.
# Reads the tokens file (default ~/.pi/agent/review-pipeline/agent-tokens.env), or the repo .env where the keys are still called THEO_GIT_TOKEN / HARVEY_GIT_TOKEN.
set -eu
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)
FILE=${1:-$HOME/.pi/agent/review-pipeline/agent-tokens.env}
[ -f "$FILE" ] || FILE=$REPO_DIR/.env
[ -f "$FILE" ] || { echo "không có file token: chạy set-secrets.sh trước" >&2; exit 2; }
# THEO_GIT_TOKEN is the same value under an older name.
map=$(mktemp)
trap 'rm -f "$map"' EXIT
sed -e 's/^THEO_GIT_TOKEN=/GH_TOKEN_THEO=/' -e 's/^HARVEY_GIT_TOKEN=/GH_TOKEN_HARVEY=/' "$FILE" > "$map"
set -a
# shellcheck disable=SC1090
. "$map"
set +a
for pair in "GH_TOKEN_THEO:swaglive/swag-server" "GH_TOKEN_HARVEY:swaglive/swag-op-console-server"; do
  var=${pair%%:*}; repo=${pair#*:}; token=${!var:-}
  printf '%-14s ' "$var"
  if [ -z "$token" ]; then echo "trống, chưa nạp"; continue; fi
  who=$(GH_TOKEN=$token gh api user -q .login 2>&1 | head -1)
  scopes=$(GH_TOKEN=$token gh api -i user 2>/dev/null | tr -d '\r' | sed -n 's/^x-oauth-scopes: //Ip')
  head=$(GH_TOKEN=$token gh api "repos/$repo/pulls?state=open&per_page=1" -q '.[0].number // "không có PR mở"' 2>&1 | head -1)
  printf 'login=%s scopes=[%s] đọc %s: %s\n' "$who" "${scopes:-fine-grained hoặc không có}" "$repo" "$head"
done
printf '%-14s ' CLAUDE_CODE_OAUTH_TOKEN; [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && echo "có (${#CLAUDE_CODE_OAUTH_TOKEN} ký tự)" || echo "trống (claude setup-token)"
printf '%-14s ' OPENCODE_API_KEY; [ -n "${OPENCODE_API_KEY:-}" ] && echo "có (${#OPENCODE_API_KEY} ký tự)" || echo "trống"
