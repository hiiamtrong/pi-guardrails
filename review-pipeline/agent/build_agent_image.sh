#!/bin/bash
# build_agent_image.sh [pi-guardrails dir]   Builds rv-agent:dev on the k3s node and imports it into k3s (no registry there).
# Unlike k3s/build_image.sh this ships the working tree, uncommitted changes included, so the image is what you tested.
# The Pi files come from ~/.pi/agent and ~/.agents; credentials (auth.json, mcp-env.json) and run state (sessions, logs, backups) stay out.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
GUARDRAILS=${1:-$(cd "$HERE/../.." && pwd)}
: "${K3S_SSH:?set K3S_SSH (user@host of the k3s node)}"
DIR=/root/rv-build/agent
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
AGENT=$HOME/.pi/agent
mkdir -p "$STAGE/pi-guardrails" "$STAGE/pi-home/.pi/agent" "$STAGE/agent"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$GUARDRAILS" --exclude=node_modules --exclude=.git --exclude=__pycache__ --exclude='.*_cache' --exclude=bench -c . | tar -C "$STAGE/pi-guardrails" -x
for f in settings.json AGENTS.md trust.json models.json auto-router.json claude-bridge.json claude-bridge-models.json github-write-confirm.json \
         session-auto-name.json hermes-memory-config.json keybindings.json mcp-adapter.json mcp-cache.json mcp-npx-cache.json \
         prompts skills agents extensions memory whoami pi-subagents pi-web-access; do
  [ ! -e "$AGENT/$f" ] || cp -R "$AGENT/$f" "$STAGE/pi-home/.pi/agent/"
done
cp -R "$HOME/.agents" "$STAGE/pi-home/.agents"
cp "$HERE"/*.sh "$HERE"/AGENTS.md "$HERE"/job.yaml "$HERE"/auto-router.json "$STAGE/agent/"
cp "$HERE/Dockerfile" "$STAGE/Dockerfile"
ssh -o BatchMode=yes "$K3S_SSH" "rm -rf $DIR && mkdir -p $DIR"
# The egress proxy is small and changes with the allowlist, so it is built in the same round trip.
mkdir -p "$STAGE/proxy"
cp "$HERE/proxy.Dockerfile" "$STAGE/proxy/Dockerfile"
cp "$HERE/squid.conf" "$STAGE/proxy/squid.conf"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -c . | ssh -o BatchMode=yes "$K3S_SSH" "tar -x -C $DIR"
ssh -o BatchMode=yes "$K3S_SSH" "cd $DIR && nohup sh -c 'docker build -t rv-agent:dev . && docker save rv-agent:dev | k3s ctr images import - && cd proxy && docker build -t rv-egress-proxy:dev . && docker save rv-egress-proxy:dev | k3s ctr images import - && echo BUILD-OK' > $DIR/build.log 2>&1 < /dev/null &"
echo "đang build trên node, log: $K3S_SSH:$DIR/build.log (xong khi có dòng BUILD-OK)"
