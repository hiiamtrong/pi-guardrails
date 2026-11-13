#!/bin/bash
# set-secrets.sh [--refresh-credentials] [file]   Fills ~/.pi/agent/review-pipeline/agent-tokens.env from prompts and applies it to the cluster.
# Nothing is printed and nothing goes into shell history: the values are read with `read -s` and never echoed.
set -eu
# --refresh-credentials re-copies the Claude login after `claude` was used on this Mac again (the access token expires and is renewed there).
REFRESH=
[ "${1:-}" != --refresh-credentials ] || { REFRESH=1; shift; }
FILE=${1:-$HOME/.pi/agent/review-pipeline/agent-tokens.env}
umask 077
touch "$FILE"; chmod 600 "$FILE"
ask() {
  local key=$1 hint=$2 value
  value=$(sed -n "s/^$key=//p" "$FILE" | tail -1)
  if [ -n "$value" ]; then
    printf '%s đã có trong %s, giữ nguyên (Enter để đổi) ' "$key" "$FILE"
  else
    printf '%s (%s): ' "$key" "$hint"
  fi
  read -rs new
  echo
  [ -n "$new" ] || return 0
  grep -v "^$key=" "$FILE" > "$FILE.tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$new" >> "$FILE.tmp"
  mv "$FILE.tmp" "$FILE"
}
# A .env kept in the repo may name them THEO_GIT_TOKEN / HARVEY_GIT_TOKEN: take the value from there first.
seed() { sed -n "s/^$1=//p" "$ENV_SRC" 2>/dev/null | tail -1; }
ENV_SRC=${ENV_SRC:-$(cd "$(dirname "$0")/../.." && pwd)/.env}
for pair in GH_TOKEN_THEO:THEO_GIT_TOKEN GH_TOKEN_HARVEY:HARVEY_GIT_TOKEN; do
  key=${pair%%:*}; alias=${pair#*:}
  [ -n "$(sed -n "s/^$key=//p" "$FILE" 2>/dev/null)" ] || [ -z "$(seed "$alias")" ] || printf '%s=%s\n' "$key" "$(seed "$alias")" >> "$FILE"
done
ask GH_TOKEN_THEO "fine-grained PAT của Sotatek-TheoNguyen2, chỉ đọc"
ask GH_TOKEN_HARVEY "fine-grained PAT của Sotatek-HarveyTran, chỉ đọc"
# The login this Mac already has (Keychain on macOS, ~/.claude/.credentials.json elsewhere): the pod then needs no setup-token.
creds=$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || cat "$HOME/.claude/.credentials.json" 2>/dev/null || true)
if [ -n "$creds" ] && { [ -n "$REFRESH" ] || ! grep -q '^CLAUDE_CREDENTIALS_B64=' "$FILE"; }; then
  grep -v '^CLAUDE_CREDENTIALS_B64=' "$FILE" > "$FILE.tmp" 2>/dev/null || true
  mv "$FILE.tmp" "$FILE"
  # base64: the JSON has quotes and braces, which a sourced env file does not survive.
  printf 'CLAUDE_CREDENTIALS_B64=%s\n' "$(printf %s "$creds" | base64)" >> "$FILE"
  echo "đã lấy login của claude từ máy này"
fi
ask CLAUDE_CODE_OAUTH_TOKEN "output của: claude setup-token (bỏ trống nếu dùng login ở trên)"
ask OPENCODE_API_KEY "key opencode-go"
set -a
# shellcheck disable=SC1090
. "$FILE"
set +a
"$(dirname "$0")/rvctl.sh" secrets
