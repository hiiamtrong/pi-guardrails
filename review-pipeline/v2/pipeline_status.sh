#!/bin/bash
# #19233 went out with build_payload.py's WARNING path unread and no table to look at; every gate here exits non-zero
# so a skipped step shows as FAIL instead of depending on the agent remembering it.
set -u
N=$1
[ -n "${RV:-}" ] || { f="$(dirname "$0")/../.pipeline-env"; [ ! -f "$f" ] || . "$f"; }  # run by hand: the /review-pr extension wrote the environment next to the tools
RV=${RV:?set RV}
[ -f "${HANDBOOK:-}" ] || { echo "ABORT: set RV, HANDBOOK and REVIEWER (the /review-pr extension does)" >&2; exit 2; }
REPO=${REPO:?set REPO (owner/name)}
T=$(cd "$(dirname "$0")" && pwd)
DRAFT=${DRAFT:-$RV/reports/reviews/$N.md}
EVID=${EVID:-$RV/reports/reviews/evidence/$N}
WT=${WT:-$(dirname "$RV")/${WT_PREFIX:?set WT_PREFIX}$N}
POST_DIR=${POST_DIR:-/tmp/rv/post}
WORK=${WORK:-$EVID/gates}
AS_OF=${AS_OF:-}
mkdir -p "$WORK" || exit 2
ROWS=()
gate() {
  local step=$1 name=$2; shift 2
  [ -z "${ONLY:-}" ] || [[ " $ONLY " == *" $step "* ]] || return 0
  [ -z "${GATES:-}" ] || [[ " $GATES " == *" $step "* ]] || return 0
  "$@" > "$WORK/$step-$name.log" 2>&1; local rc=$?
  local f; f=$(grep -c 'FAIL' "$WORK/$step-$name.log")
  local m; m=$(grep -c 'MANUAL' "$WORK/$step-$name.log")
  local st=PASS; [ $rc -ne 0 ] && st=FAIL; [ $rc -eq 2 ] && st=ABORT
  ROWS+=("$(printf '%-3s %-11s %-5s rc=%s FAIL=%-2s MANUAL=%s' "$step" "$name" "$st" "$rc" "$f" "$m")")
  [ "$st" = PASS ] || { echo "---- $step $name"; grep -E 'FAIL|ABORT|WARN|^  ' "$WORK/$step-$name.log" | head -14; }
}
HEAD=$(git -C "$WT" rev-parse HEAD) || exit 2
BASE=$(git -C "$RV" merge-base "origin/${BASE_BRANCH:-develop}" "$HEAD") || exit 2
export GH_TOKEN="$(gh auth token -h github.com -u "$REVIEWER")"
LABELS=$(gh api "repos/$REPO/issues/$N" --jq '[.labels[].name]|join(",")') || exit 2

gate 00 intake "$T/gate_intake.sh" "$N" "$WT"
gate 01 comments env ${SEEN:+SEEN=$SEEN} "$T/gate_comments.sh" "$N" "$DRAFT" "$AS_OF"
gh api "repos/$REPO/pulls/$N" --jq .body > "$WORK/description.txt" || exit 2
if [ -z "${DRAFT_CHECK:-}" ] && { [ -z "${GATES:-}" ] || [[ " $GATES " == *" 04 "* ]] || [[ " $GATES " == *" 05 "* ]]; }; then
  python3.12 "$T/scan_triggers.py" "$WT" "$BASE" "$HEAD" "$WORK/description.txt" > "$WORK/triggers.tsv" || { echo "ABORT: scan_triggers.py failed" >&2; exit 2; }
  python3.12 "$T/scan_expected.py" "$WT" "$BASE" "$HEAD" > "$WORK/expected.tsv" || { echo "ABORT: scan_expected.py failed" >&2; exit 2; }
else
  : > "$WORK/triggers.tsv"; : > "$WORK/expected.tsv"
fi
gate 02 impact-map python3.12 "$T/check_impact.py" "$EVID/impact-map.txt" --head "$HEAD" --base "$BASE" --sections "${IMPACT_SECTIONS:-8}"
git -C "$WT" diff --name-only "$BASE" "$HEAD" > "$WORK/changed.txt" || exit 2
gate 03 runs python3.12 "$T/check_runs.py" --head "$HEAD" --changed "$WORK/changed.txt" "$EVID"/runs*.txt
outside_check() {
  python3.12 "$T/check_draft.py" "$DRAFT" --step 04 --triggers "$WORK/triggers.tsv" --expected "$WORK/expected.tsv" --wt "$WT" --labels "$LABELS" --rv "$RV" --evid-root "$(dirname "$(dirname "$EVID")")"
}
[ -n "${DRAFT_CHECK:-}" ] || gate 04 outside outside_check
draft_check() {
  if [ -n "${DRAFT_CHECK:-}" ]; then python3.12 "$T/$DRAFT_CHECK" "$DRAFT" --wt "$WT" --head "$HEAD"; return; fi
  python3.12 "$T/check_draft.py" "$DRAFT" --triggers "$WORK/triggers.tsv" --expected "$WORK/expected.tsv" --wt "$WT" --labels "$LABELS" --rv "$RV" --evid-root "$(dirname "$(dirname "$EVID")")"
}
gate 05 draft draft_check
pin_ok() {
  local d; d=$(basename "$DRAFT" .md)
  [ -f "$POST_DIR/$d.approved.sha256" ] || { echo "PIN: FAIL chưa có $POST_DIR/$d.approved.sha256 (người review chưa OK)"; return 1; }
  (cd "$POST_DIR" && shasum -a 256 -c "$d.approved.sha256" >/dev/null) && echo "PIN: PASS payload trùng pin" || { echo "PIN: FAIL payload khác pin"; return 1; }
  echo "PIN: MANUAL người review đã nói OK post"
}
gate 06 pin pin_ok
if grep -q '^- Trạng thái: \*\*đã post' "$DRAFT" && [ -z "$AS_OF" ]; then gate 07 after "$T/after_post.sh" "$N" "$DRAFT"; fi
echo "==== #$N head ${HEAD:0:10} base ${BASE:0:10} draft $(basename "$DRAFT")${AS_OF:+ as-of $AS_OF} | triggers: $(cut -f1 "$WORK/triggers.tsv" | sort | uniq -c | tr -s ' ' | tr '\n' ' ')| tests cần xếp loại: $(grep -vc NONE "$WORK/expected.tsv")"
printf '%s\n' "${ROWS[@]}"
printf '%s\n' "${ROWS[@]}" | grep -qE ' (FAIL|ABORT) ' && exit 1 || exit 0
