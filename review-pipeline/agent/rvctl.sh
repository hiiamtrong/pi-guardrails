#!/bin/bash
# rvctl.sh sync | secrets | memory-diff | review <project> <PR> [model] | fetch <project> <PR> [--force] | draft | ask | post | status
# Drives the review agent on the k3s node (namespace review-agent): starts reviews, brings their drafts back, and posts one on request.
# Projects come from $REVIEW_PIPELINE_HOME/agent-projects.json (shape: projects.example.json), kept beside the rules and out of the repo.
set -eu -o pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
HOME_RULES=${REVIEW_PIPELINE_HOME:-$HOME/.pi/agent/review-pipeline}
# plugboard runs these from a launchd app with no shell environment: the node is the one the rules already name.
if [ -z "${K3S_SSH:-}" ]; then
  K3S_SSH=$(jq -r '.k3sHost // empty' "$HOME_RULES"/projects/*/pipeline.json 2>/dev/null | grep -v '^local$' | head -1)
fi
: "${K3S_SSH:?set K3S_SSH (user@host of the k3s node)}"
NS=review-agent
CFG=$HOME_RULES/agent-projects.json
POD_HOME=/Users/hiiamtrong

# ssh joins its arguments into one string for the node's shell, so each one is quoted for it.
kc() { local line="kubectl -n $NS" a; for a in "$@"; do line+=" $(printf '%q' "$a")"; done; ssh -o BatchMode=yes "$K3S_SSH" "$line"; }
files() { kc exec -i deploy/agent-files -- "$@"; }
project() { jq -r --arg n "$1" --arg k "$2" '.[$n][$k] // empty' "$CFG"; }
known() { [ -n "$(project "$1" repo)" ] || { echo "không có project '$1' trong $CFG" >&2; exit 2; }; }
pack() { COPYFILE_DISABLE=1 tar --no-xattrs "$@"; }

case "${1:-}" in
  sync)
    files mkdir -p "$POD_HOME/.pi/agent/review-pipeline" "$POD_HOME/.pi/agent/sessions" "$POD_HOME/.pi/agent/memory" "$POD_HOME/.claude" "$POD_HOME/Works"
    pack -C "$HOME_RULES" --exclude=__pycache__ --exclude='*.pyc' -c projects | files tar -x -C "$POD_HOME/.pi/agent/review-pipeline"
    # Mac to pod only: what the agent writes there stays in the pod until memory-diff shows it to you.
    pack -C "$HOME/.pi/agent" -c memory | files tar -x -C "$POD_HOME/.pi/agent"
    # In the pod the tests run through its service account, not ssh.
    files sh -c 'for f in "$HOME"/.pi/agent/review-pipeline/projects/*/pipeline.json; do jq ".k3sHost = \"local\"" "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done'
    # The handbook and skills are untracked in the review checkouts, so only a copy from here gets them into the pod.
    # k3s-images is a list, not a project
    for name in $(jq -r 'to_entries[] | select(.value | type == "object") | .key' "$CFG"); do
      dir=$(project "$name" dir)
      keep=()
      for f in AGENTS.local.md AGENTS.md CLAUDE.md .claude reports/reviews/_template.md; do
        [ -e "$dir/$f" ] && ! git -C "$dir" ls-files --error-unmatch "$f" >/dev/null 2>&1 && keep+=("$f")
      done
      [ ${#keep[@]} -eq 0 ] || { files mkdir -p "$dir"; pack -C "$dir" -c "${keep[@]}" | files tar -x -C "$dir"; }
      echo "sync: $name (${keep[*]:-không có file handbook riêng})"
    done
    # The agent cannot reach docker or k3s ctr (no ssh, no host access), so a test image that kubelet's image GC dropped is put back from here.
    images=$(jq -r '."k3s-images" // [] | .[]' "$CFG" 2>/dev/null || true)
    for img in $images; do
      ssh -o BatchMode=yes "$K3S_SSH" "k3s ctr images ls -q | grep -qx docker.io/library/$img || { docker image inspect $img >/dev/null 2>&1 && docker save $img | k3s ctr images import - >/dev/null && echo \"sync: nhập lại image $img vào k3s\"; }" || echo "sync: thiếu image $img trên node, build lại bằng review-pipeline/k3s/build_image.sh" >&2
    done
    ssh -o BatchMode=yes "$K3S_SSH" "cat > /tmp/agent-projects.json && kubectl -n $NS create configmap projects --from-file=projects.json=/tmp/agent-projects.json --dry-run=client -o yaml | kubectl apply -f - && rm /tmp/agent-projects.json" < "$CFG"
    ;;
  secrets)
    # Read from the environment and sent on stdin, so a token never shows in a process list or in shell history.
    # A merge patch adds or replaces the keys it carries and leaves the others alone. `kubectl apply` would delete the keys this call omits,
    # and updating one token has silently removed another (twice).
    ssh -o BatchMode=yes "$K3S_SSH" "kubectl -n $NS get secret agent-secrets >/dev/null 2>&1 || kubectl -n $NS create secret generic agent-secrets >/dev/null"
    # Written to a file first: a pipe to ssh turns into 141 (jq killed by SIGPIPE) whenever the remote command exits early, and that hides the real error.
    patch=$(umask 077; mktemp)
    trap 'rm -f "$patch"' EXIT
    jq -n '{stringData: ({GH_TOKEN_THEO: env.GH_TOKEN_THEO, GH_TOKEN_HARVEY: env.GH_TOKEN_HARVEY,
                          CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CREDENTIALS_B64: env.CLAUDE_CREDENTIALS_B64,
                          OPENCODE_API_KEY: env.OPENCODE_API_KEY, NOTION_TOKEN: env.NOTION_TOKEN} | with_entries(select(.value)))}' > "$patch"
    ssh -o BatchMode=yes "$K3S_SSH" "kubectl -n $NS patch secret agent-secrets --type=merge --patch-file /dev/stdin" < "$patch"
    missing=$(for v in GH_TOKEN_THEO GH_TOKEN_HARVEY CLAUDE_CREDENTIALS_B64 OPENCODE_API_KEY NOTION_TOKEN; do [ -n "${!v:-}" ] || printf '%s ' "$v"; done)
    [ -z "$missing" ] || echo "secrets: bỏ qua (trống, key cũ giữ nguyên): $missing" >&2
    # A missing GitHub or OpenCode key stops the first Job seconds later; say so now, where the human is looking.
    for v in GH_TOKEN_THEO GH_TOKEN_HARVEY OPENCODE_API_KEY; do
      [ -n "${!v:-}" ] || { echo "secrets: thiếu $v, Job của project dùng key đó sẽ ABORT" >&2; exit 2; }
    done
    ;;
  draft)
    # rvctl.sh draft <project> <PR>   or   rvctl.sh draft <PR url>   Prints the draft the agent wrote, fetching it first if the checkout lacks it.
    case "${2:-}" in
      https://github.com/*/pull/*) repo=$(printf %s "$2" | cut -d/ -f4-5); PR=${2##*/}
        NAME=$(jq -r --arg r "$repo" 'to_entries[] | select(.value|type == "object") | select(.value.repo == $r) | .key' "$CFG" | head -1) ;;
      *) NAME=${2:?project}; PR=${3:?PR} ;;
    esac
    [ -n "${NAME:-}" ] || { echo "không có project nào trong $CFG nhận pull request đó" >&2; exit 2; }
    known "$NAME"
    case "$PR" in ''|*[!0-9]*) echo "PR phải là số" >&2; exit 2 ;; esac
    dir=$(project "$NAME" dir); local=$dir/reports/reviews/$PR.md
    if [ ! -f "$local" ]; then
      mkdir -p "$dir/reports/reviews"
      files sh -c "cat '$dir/reports/reviews/$PR.md'" > "$local" 2>/dev/null && echo "draft: đã lấy $local từ cluster" >&2
    fi
    [ -s "$local" ] || { echo "không có bản nháp cho #$PR (chưa review xong hoặc sai project)" >&2; exit 2; }
    cat "$local"
    ;;
  ask)
    # rvctl.sh ask <PR url> "<question>"   Answers a question about that review with the draft and its evidence in front of the model.
    case "${2:-}" in
      https://github.com/*/pull/*) repo=$(printf %s "$2" | cut -d/ -f4-5); PR=${2##*/}
        NAME=$(jq -r --arg r "$repo" 'to_entries[] | select(.value|type == "object") | select(.value.repo == $r) | .key' "$CFG" | head -1) ;;
      *) NAME=${2:?project}; PR=${3:?PR} ;;
    esac
    QUESTION=${3:-}; [ -n "${QUESTION:-}" ] || QUESTION=${4:-}
    [ -n "${NAME:-}" ] || { echo "không có project nào trong $CFG nhận pull request đó" >&2; exit 2; }
    [ -n "${QUESTION:-}" ] || { echo "cần câu hỏi: rvctl.sh ask <url> \"<câu hỏi>\"" >&2; exit 2; }
    known "$NAME"
    dir=$(project "$NAME" dir); local=$dir/reports/reviews/$PR.md
    [ -s "$local" ] || { echo "chưa có bản nháp trên máy: chạy rvctl.sh draft <url> trước" >&2; exit 2; }
    # Same checkout, same rules, same model routing as a review: it answers as the reviewer that wrote that draft, not as a new session.
    ( cd "$dir"
      timeout "${ASK_TIMEOUT:-240}" pi -p --model "${MODEL:-router}" --append-system-prompt "You wrote the review draft $local for pull request #$PR. Answer the question about it from that draft and the evidence in reports/reviews/evidence/$PR/: short, concrete, cite file:line when you make a claim. Reply in Vietnamese." "$QUESTION"
    )
    ;;
  post)
    # rvctl.sh post <project> <PR> [--yes]   or   rvctl.sh post <PR url> [--yes]
    case "${2:-}" in
      https://github.com/*/pull/*) repo=$(printf %s "$2" | cut -d/ -f4-5); PR=${2##*/}
        NAME=$(jq -r --arg r "$repo" 'to_entries[] | select(.value|type == "object") | select(.value.repo == $r) | .key' "$CFG" | head -1) ;;
      *) NAME=${2:?project}; PR=${3:?PR} ;;
    esac
    [ -n "${NAME:-}" ] || { echo "không có project nào trong $CFG nhận pull request đó" >&2; exit 2; }
    known "$NAME"
    case "$PR" in ''|*[!0-9]*) echo "PR phải là số" >&2; exit 2 ;; esac
    dir=$(project "$NAME" dir); draft=$dir/reports/reviews/$PR.md
    [ -f "$draft" ] || { echo "chưa có bản nháp trên máy: chạy rvctl.sh fetch $NAME $PR trước" >&2; exit 2; }
    [ -f "$dir/reports/reviews/tools/build_payload.py" ] || { echo "chưa có tools trong $dir: chạy /review-pr ở đó một lần" >&2; exit 2; }
    # One post per pull request at a time: a double click must not send two reviews before the first one shows up on GitHub.
    mkdir -p /tmp/rv/post
    lock=/tmp/rv/post/$PR.lock
    mkdir "$lock" 2>/dev/null || { echo "PR #$PR đang được post ở lần khác, chờ rồi thử lại (nếu chắc không còn lần nào: rmdir $lock)" >&2; exit 2; }
    trap 'rmdir "$lock"' EXIT
    # Step 06, cut down to what a button can check: the pull request is still open on the head the draft reviewed and I have not reviewed
    # that head yet. The full guard (watchPaths, description, file list) stays a manual step: it needs inputs only the draft's author had.
    ( cd "$dir"
      set -a; . reports/reviews/tools/.pipeline-env; set +a
      GH_TOKEN=$(gh auth token -h github.com -u "$REVIEWER") || { echo "không lấy được token của $REVIEWER" >&2; exit 2; }
      export GH_TOKEN
      head_now=$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha') || { echo "không đọc được PR" >&2; exit 2; }
      state=$(gh api "repos/$REPO/pulls/$PR" --jq '.state')
      [ "$state" = open ] || { echo "PR #$PR đang $state, không post" >&2; exit 2; }
      draft_head=$(sed -n 's/.*Reviewed head: `\([0-9a-f]\{40\}\)`.*/\1/p' "$draft" | head -1)
      [ -n "$draft_head" ] || { echo "bản nháp không ghi Reviewed head" >&2; exit 2; }
      [ "$head_now" = "$draft_head" ] || { echo "head đã đổi (draft $draft_head, PR $head_now): fetch lại rồi review vòng mới" >&2; exit 2; }
      # Dismissed counts too: dismissing a review does not undo it, and it is what a second click would duplicate.
      mine=$(gh api --paginate "repos/$REPO/pulls/$PR/reviews?per_page=100" --jq "[.[] | select(.user.login == \"$REVIEWER\" and .commit_id == \"$head_now\")] | length")
      [ "$mine" = 0 ] || { echo "đã có review của $REVIEWER trên head này, không post trùng" >&2; exit 2; }
      python3 reports/reviews/tools/build_payload.py "$PR" >/dev/null || exit 2
      shasum -a 256 "/tmp/rv/post/$PR.review.json" > "/tmp/rv/post/$PR.approved.sha256"
      python3.12 reports/reviews/tools/v2/seen_from_table.py "$draft" > "/tmp/rv/post/$PR.seen"
      event=$(sed -n 's/.*Planned event: `\([A-Z_]*\)`.*/\1/p' "$draft" | head -1)
      # --yes can sit in any position: the Plugboard button sends it right after the URL, a shell user after the PR number.
      case " $* " in *" --yes "*) ;; *) echo "post: dry-run (thêm --yes để gửi), payload $(wc -c < "/tmp/rv/post/$PR.review.json" | tr -d ' ') bytes, event $event, head $head_now"; exit 0 ;; esac
      out=$(gh api "repos/$REPO/pulls/$PR/reviews" -X POST --input "/tmp/rv/post/$PR.review.json") || { echo "post lỗi" >&2; exit 2; }
      id=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
      mkdir -p "reports/reviews/evidence/$PR"
      printf 'posted %s event=%s review=%s head=%s\n' "$(date -u +%FT%TZ)" "$event" "$id" "$head_now" > "reports/reviews/evidence/$PR/post.txt"
      # agent_state.sh reads the pod: without this line the badge would keep saying "draft" after a post made here.
      files sh -c "mkdir -p '$dir/reports/reviews/evidence/$PR' && cat > '$dir/reports/reviews/evidence/$PR/post.txt'" < "reports/reviews/evidence/$PR/post.txt" \
        || echo "post: không ghi được dấu post lên cluster, badge sẽ còn 'draft'" >&2
      echo "post: $REPO#$PR $(printf '%s' "$event") review=${id:-?}"
    )
    ;;
  memory-diff)
    # Files the agent added to, or changed in, its memory since the last sync (sync lets this machine win, so these are the agent's own notes).
    sums() { (cd "$1" && find memory -type f ! -name '.DS_Store' -print0 | xargs -0 shasum -a 256 | LC_ALL=C sort -k2); }
    out=$(diff <(sums "$HOME/.pi/agent") <(files sh -c 'cd "$HOME/.pi/agent" && find memory -type f ! -name .DS_Store -print0 | xargs -0 shasum -a 256 | LC_ALL=C sort -k2') | grep '^[<>]' | sed -e 's/^< /Mac only: /' -e 's/^> /pod:      /' || true)
    echo "${out:-memory của pod khớp máy này}"
    ;;
  review)
    NAME=${2:?project}; PR=${3:?PR}
    known "$NAME"
    case "$PR" in ''|*[!0-9]*) echo "PR phải là số" >&2; exit 2 ;; esac
    running=$(kc get jobs -l "rv/project=$NAME,rv/pr=$PR" -o json | jq '[.items[] | select((.status.active // 0) > 0)] | length')
    [ "$running" -eq 0 ] || { echo "PR #$PR của $NAME đang có Job chạy; đợi nó xong hoặc xoá Job đó trước" >&2; exit 2; }
    JOB=rv-$(printf %s "$NAME" | tr -c 'a-z0-9' - | cut -c1-20 | sed 's/-*$//')-$PR-$(date +%s)
    sed -e "s|__JOB__|$JOB|g" -e "s|__PROJECT__|$NAME|g" -e "s|__PR__|$PR|g" -e "s|__TOKEN_VAR__|$(project "$NAME" tokenVar)|g" -e "s|__MODEL__|${4:-router}|g" "$HERE/job.yaml" | kc create -f -
    echo "log: K3S_SSH=$K3S_SSH ssh \$K3S_SSH kubectl -n $NS logs -f job/$JOB"
    ;;
  fetch)
    NAME=${2:?project}; PR=${3:?PR}; FORCE=${4:-}
    known "$NAME"
    dir=$(project "$NAME" dir)
    [ -d "$dir" ] || { echo "không có checkout $dir trên máy này" >&2; exit 2; }
    stage=$(mktemp -d)
    trap 'rm -rf "$stage"' EXIT
    # Exact draft names only: 10*.md would also pull 100.md and 1048.md.
    files sh -c "cd '$dir' && { find reports/reviews -maxdepth 1 -type f \( -name '$PR.md' -o -name '$PR-r*.md' \); [ ! -d reports/reviews/evidence/$PR ] || echo reports/reviews/evidence/$PR; } | tar -c -T -" | tar -x -C "$stage"
    # A second fetch of the same run must not overwrite a draft you edited, unless you say --force.
    conflicts=$(cd "$stage" && find reports -type f | while read -r f; do [ ! -e "$dir/$f" ] || echo "$f"; done)
    if [ -n "$conflicts" ] && [ "$FORCE" != --force ]; then
      echo "fetch: đã có $(printf '%s\n' "$conflicts" | wc -l | tr -d ' ') file trên máy này (ví dụ $(printf '%s\n' "$conflicts" | head -1)); thêm --force để ghi đè" >&2
      exit 2
    fi
    cp -R "$stage/reports/." "$dir/reports/"
    # Step 06 reads the PR's tree (pipeline_status, post guard), and the pod deletes its worktree when it finishes.
    prefix=$(jq -r '.worktreePrefix // empty' "$HOME_RULES/projects/$(printf %s "$dir" | tr / -)/pipeline.json" 2>/dev/null)
    wt=$(cd "$dir/.." && pwd)/${prefix:-$(basename "$dir" -review)-pr-}$PR
    if [ -d "$wt" ]; then
      echo "fetch: worktree $wt đã có"
    else
      git -C "$dir" fetch -q origin "+pull/$PR/head:refs/remotes/pr/$PR" && git -C "$dir" worktree add -q --detach "$wt" "refs/remotes/pr/$PR" \
        && echo "fetch: worktree $wt ở head của PR"
    fi
    echo "fetch: bản nháp và evidence của #$PR đã vào $dir/reports/reviews"
    ;;
  status)
    kc get cronjobs,jobs -o wide
    ;;
  *)
    echo "usage: rvctl.sh sync | secrets | memory-diff | review <project> <PR> [model] | fetch <project> <PR> [--force] | draft <url> | ask <url> <question> | post <url> --yes | status" >&2; exit 2 ;;
esac
