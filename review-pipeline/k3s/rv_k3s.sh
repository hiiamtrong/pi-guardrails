#!/bin/bash
# rv_k3s.sh run <profile> <PR> <worktree> <command>
# Runs <command> (a shell snippet) on a pod of its own on the k3s node: the PR's code and its databases live and die together, so two
# reviews never share a database, a lock or a container. The reviewer's agent stays on this machine; only the test run goes to the node.
#   queue:  the pod waits (Pending) until the node has room for it. Waiting is free: RV_QUEUE_WAIT (default 1200 s) only caps how long we are willing to wait, so a slot is found well inside an agent tool call.
#   setup:  starts databases, builds the schema. Capped by RV_SETUP_TIMEOUT (default 600 s).
#   run:    <command> in the pod. RV_RUN_TIMEOUT (default 1500 s) starts only here, once the pod is ready and set up.
#   gone:   the pod is deleted on exit, on a signal, and by the node itself after RV_POD_DEADLINE (default 5400 s) if this machine dies.
# Needs K3S_SSH (user@host of the node, set by "k3sHost" in pipeline.json). Output of <command> goes to stdout, our own messages to stderr.
# Exit: the command's own status, or 123 the PR head moved while we waited, 124 a timeout, 125 the node or the pod could not be used.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
NS=review-env
[ "${1:-}" = run ] && [ $# -ge 5 ] || { echo "usage: rv_k3s.sh run <profile> <PR> <worktree> <command>" >&2; exit 125; }
PROFILE=$2; PR=$3; WT=$4; CMD=$5
case "$PR" in ''|*[!0-9]*) echo "ABORT: PR phải là số, nhận được '$PR'" >&2; exit 125 ;; esac
case "$PROFILE" in ''|*[!a-z0-9-]*) echo "ABORT: tên profile lạ '$PROFILE'" >&2; exit 125 ;; esac
[ -n "${K3S_SSH:-}" ] || { echo "ABORT: K3S_SSH trống: đặt \"k3sHost\": \"user@host\" trong pipeline.json của dự án (host của node k3s qua Tailscale)" >&2; exit 125; }
[ -f "$HERE/profiles/$PROFILE.pod.yaml" ] || { echo "ABORT: không có profile $PROFILE trong $HERE/profiles" >&2; exit 125; }
[ -d "$WT" ] || { echo "ABORT: không có worktree $WT" >&2; exit 125; }
# shellcheck disable=SC1090
. "$HERE/profiles/$PROFILE.conf"
CTL=$(mktemp -d "${TMPDIR:-/tmp}/rv-k3s.XXXXXX")
RC=125
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ControlMaster=auto -o "ControlPath=$CTL/ssh" -o ControlPersist=120 "$K3S_SSH")
# ssh joins its arguments into one string for the node's shell, so each one is quoted for it.
kc() { local line="kubectl -n $NS" a; for a in "$@"; do line+=" $(printf '%q' "$a")"; done; "${SSH[@]}" "$line"; }
POD="rv-$PROFILE-$PR-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 6)"
KILLED=
CREATED=
cleanup() {
  [ -z "${WATCH_PIDS:-}" ] || kill $WATCH_PIDS 2>/dev/null
  [ -z "$CREATED" ] || kc delete pod "$POD" --wait=false --grace-period=1 >/dev/null 2>&1
  "${SSH[@]}" -O exit >/dev/null 2>&1
  rm -rf "$CTL"
}
trap 'cleanup' EXIT
trap 'exit 125' INT TERM HUP

# Runs "$@" with a limit of $1 seconds (the sleep is killed when the command ends in time, so && skips the rest). Sets KILLED when it cut it short.
WATCH_PIDS=
limited() {
  local limit=$1; shift
  "$@" <&0 &   # a background job would otherwise get /dev/null instead of our stdin
  local job=$!
  ( sleep "$limit" && { : > "$CTL/killed"; kill "$job" 2>/dev/null; } ) 2>/dev/null &
  local dog=$!
  WATCH_PIDS="$WATCH_PIDS $dog"
  wait "$job"; local rc=$?
  pkill -P "$dog" 2>/dev/null; kill "$dog" 2>/dev/null; wait "$dog" 2>/dev/null
  [ ! -e "$CTL/killed" ] || { rm -f "$CTL/killed"; KILLED=1; }
  return "$rc"
}

head_moved() {
  local checker="$HERE/../v2/check_head.sh"
  [ -x "$checker" ] || return 1
  # The scripts that call us may have reused REPO for a path: the environment the extension wrote next to the tools is the source of truth.
  ( [ ! -f "$HERE/../.pipeline-env" ] || . "$HERE/../.pipeline-env"; exec "$checker" "$PR" ) >/dev/null 2>"$CTL/head"; [ $? -eq 5 ]
}
if head_moved; then cat "$CTL/head" >&2; RC=123; exit 123; fi

# Sweep by age, never by phase alone: a finished pod of a review running right now keeps its log for an hour, and a pod whose creator died before
# it was scheduled (so the node's deadline never started) goes once it is older than the deadline plus the longest queue.
"${SSH[@]}" "bash -s" >/dev/null 2>&1 <<SWEEP
now=\$(date +%s)
kubectl -n $NS get pods -o jsonpath='{range .items[*]}{.metadata.name} {.metadata.creationTimestamp} {.status.phase}{"\n"}{end}' | while read -r name created phase; do
  age=\$((now - \$(date -d "\$created" +%s)))
  case "\$phase" in
    Failed|Succeeded) [ "\$age" -gt 3600 ] || continue ;;
    *) [ "\$age" -gt $(( ${RV_POD_DEADLINE:-5400} + ${RV_QUEUE_WAIT:-1200} + 300 )) ] || continue ;;
  esac
  kubectl -n $NS delete pod "\$name" --wait=false
done
SWEEP

# The runner image is local to the node (imagePullPolicy Never), and kubelet's image GC drops unused images when the disk passes 85%: put it back from docker's copy.
"${SSH[@]}" "k3s ctr images ls -q | grep -qx docker.io/library/$RV_IMAGE || { docker image inspect $RV_IMAGE >/dev/null 2>&1 && docker save $RV_IMAGE | k3s ctr images import - >/dev/null; }" >/dev/null 2>&1

sed -e "s|__POD__|$POD|g" -e "s|__PR__|$PR|g" -e "s|__REPO__|$PROFILE|g" -e "s|__IMAGE__|$RV_IMAGE|g" -e "s|__MONGO_IMAGE__|${RV_MONGO_IMAGE:-mongo:7.0.11}|g" -e "s|__DEADLINE__|${RV_POD_DEADLINE:-5400}|g" \
  "$HERE/profiles/$PROFILE.pod.yaml" | kc create -f - >/dev/null || { echo "ABORT: không tạo được pod trên k3s (kubectl create lỗi)" >&2; exit 125; }
CREATED=1

# Queue: Pending is the normal wait for room on the node; a pod that cannot start for another reason is reported at once.
echo "k3s: pod $POD, đợi node có chỗ" >&2
waited=0; noted=
while :; do
  state=$(kc get pod "$POD" -o jsonpath='{.status.phase} {.status.conditions[?(@.type=="Ready")].status} W:{.status.containerStatuses[*].state.waiting.reason} T:{.status.containerStatuses[*].state.terminated.reason}' 2>/dev/null)
  case "$state" in
    "Running True"*) break ;;
    Failed*|Succeeded*) echo "ABORT: pod $POD dừng khi chưa chạy: $(kc get pod "$POD" -o jsonpath='{.status.reason} {.status.message}' 2>/dev/null)" >&2; exit 125 ;;
    *"T:"*[A-Za-z]*) echo "ABORT: một container của pod $POD đã dừng trước khi test chạy ($state):" >&2
      for c in $(kc get pod "$POD" -o jsonpath='{range .status.containerStatuses[?(@.state.terminated)]}{.name} {end}' 2>/dev/null); do echo "--- $c" >&2; kc logs "$POD" -c "$c" --tail=15 >&2 2>&1; done
      exit 125 ;;
    *ErrImageNeverPull*|*InvalidImageName*|*CreateContainerConfigError*) echo "ABORT: pod $POD không khởi động được ($state): image $RV_IMAGE chưa có trên node, chạy k3s/build_image.sh $PROFILE" >&2; exit 125 ;;
  esac
  [ "$waited" -lt "${RV_QUEUE_WAIT:-1200}" ] || { echo "ABORT: đợi quá ${RV_QUEUE_WAIT:-1200}s mà node vẫn chưa có chỗ cho pod $POD" >&2; exit 125; }
  if [ "$waited" -gt 0 ] && [ $((waited % ${RV_HEAD_CHECK:-60})) -eq 0 ] && head_moved; then cat "$CTL/head" >&2; RC=123; exit 123; fi
  [ -n "$noted" ] || [ "$waited" -lt 20 ] || { noted=1; echo "k3s: vẫn đợi chỗ ($state), thời gian đợi không tính vào hạn chạy test" >&2; }
  sleep "${RV_POLL:-2}"; waited=$((waited + ${RV_POLL:-2}))
done
echo "k3s: pod sẵn sàng sau ${waited}s, chép mã PR lên" >&2

# The whole worktree goes up (the image only holds the dependencies); COPYFILE_DISABLE keeps macOS ._ files out.
COPYFILE_DISABLE=1 tar -C "$WT" -c --no-xattrs --exclude=./.git --exclude=./.venv --exclude=./reports --exclude=./node_modules --exclude=__pycache__ --exclude=.pytest_cache . \
  | "${SSH[@]}" "kubectl -n $NS exec -i $POD -c runner -- tar -x -o -C $RV_WORKDIR" \
  || { echo "ABORT: không chép được mã PR vào pod $POD" >&2; exit 125; }

limited "${RV_SETUP_TIMEOUT:-600}" "${SSH[@]}" "kubectl -n $NS exec -i $POD -c runner -- sh -s" < "$HERE/profiles/$PROFILE.setup.sh" >"$CTL/setup.out" 2>&1
setup_rc=$?
if [ -n "$KILLED" ]; then tail -20 "$CTL/setup.out" >&2; echo "ABORT: dựng môi trường quá ${RV_SETUP_TIMEOUT:-600}s" >&2; RC=124; exit 124; fi
if [ "$setup_rc" -ne 0 ]; then tail -30 "$CTL/setup.out" >&2; echo "ABORT: dựng môi trường lỗi (exit $setup_rc)" >&2; exit 125; fi

# The run: from here the clock counts.
printf '[ ! -f /tmp/rv.env ] || . /tmp/rv.env\ncd %s\nexec 2>&1\n%s\n' "$RV_WORKDIR" "$CMD" > "$CTL/run.sh"
echo "k3s: chạy test (hạn ${RV_RUN_TIMEOUT:-1500}s)" >&2
limited "${RV_RUN_TIMEOUT:-1500}" "${SSH[@]}" "kubectl -n $NS exec -i $POD -c runner -- sh -s" < "$CTL/run.sh"
RC=$?
if [ -n "$KILLED" ]; then echo "ABORT: test chạy quá ${RV_RUN_TIMEOUT:-1500}s (không tính thời gian xếp hàng), đã xoá pod $POD" >&2; RC=124; fi
exit "$RC"
