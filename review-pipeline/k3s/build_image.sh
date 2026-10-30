#!/bin/bash
# build_image.sh <profile> <checkout> [ref]   Builds the runner image of a profile on the k3s node (the node is amd64, this machine may not be, and
# k3s has no registry), then imports it into k3s. Run again when the checkout's dependencies change; the pods use the image, not the PR's lock file.
# Needs K3S_SSH like rv_k3s.sh. The build runs on the node in the background: follow it with the log path this prints.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PROFILE=${1:?profile}; CHECKOUT=${2:?checkout}; REF=${3:-origin/develop}
: "${K3S_SSH:?set K3S_SSH (user@host of the k3s node)}"
. "$HERE/profiles/$PROFILE.conf"
DIR=/root/rv-build/$PROFILE
ssh -o BatchMode=yes "$K3S_SSH" "rm -rf $DIR && mkdir -p $DIR"
git -C "$CHECKOUT" archive --format=tar "$REF" | ssh -o BatchMode=yes "$K3S_SSH" "tar -x -C $DIR"
ssh -o BatchMode=yes "$K3S_SSH" "cat > $DIR/Dockerfile.review" < "$HERE/profiles/$PROFILE.Dockerfile"
ssh -o BatchMode=yes "$K3S_SSH" "cd $DIR && nohup sh -c '$(rv_build) && docker save $RV_IMAGE | k3s ctr images import - && echo BUILD-OK' > $DIR/build.log 2>&1 < /dev/null &"
echo "đang build trên node, log: $K3S_SSH:$DIR/build.log (xong khi có dòng BUILD-OK)"
