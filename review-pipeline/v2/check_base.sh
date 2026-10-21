#!/bin/bash
# check_base.sh <owner/name> <PR> <base ref>   exit 0 when the base is develop or the head ref of an open parent PR named under PR Dependencies.
# Han merges a stack into its parent's branch, so a stacked PR never targets develop. Prints what accepted it.
set -u
REPO=$1; N=$2; BASE=$3
[ "$BASE" != develop ] || { echo "develop"; exit 0; }
DEPS=$(gh api "repos/$REPO/pulls/$N" --jq .body | tr -d '\r' | sed -n '/PR Dependencies/,/^## /p' | grep -oE '(#|/pull/)[0-9]+' | grep -oE '[0-9]+' | sort -u)
for dep in $DEPS; do
  PARENT_REF=$(gh api "repos/$REPO/pulls/$dep" --jq 'select(.state == "open") | .head.ref' 2>/dev/null)
  if [ -n "$PARENT_REF" ] && [ "$PARENT_REF" = "$BASE" ]; then echo "stacked on open #$dep, whose head ref is this base"; exit 0; fi
done
exit 1
