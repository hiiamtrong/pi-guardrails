# The review agent: the same Pi as the reviewer's machine (same version, settings.json, packages, skills, prompts, memory), plus what the pipeline's
# scripts call (gh, git, jq, python3.12, kubectl). Built on the k3s node by build_agent_image.sh (k3s has no registry).
# The scripts say python3.12 by name, hence the python base with node copied in.
FROM node:24-bookworm-slim AS pi
RUN npm install -g @earendil-works/pi-coding-agent@1.5.0

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates jq procps tar gzip perl \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pyyaml
# gh and kubectl as release binaries; kubectl matches the cluster (k3s v1.36.4).
RUN curl -fsSL https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_linux_amd64.tar.gz | tar -xz -C /tmp \
    && mv /tmp/gh_2.100.0_linux_amd64/bin/gh /usr/local/bin/gh && rm -rf /tmp/gh_2.100.0_linux_amd64 \
    && curl -fsSL -o /usr/local/bin/kubectl https://dl.k8s.io/release/v1.36.4/bin/linux/amd64/kubectl && chmod +x /usr/local/bin/kubectl
COPY --from=pi /usr/local/bin/node /usr/local/bin/node
COPY --from=pi /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && npm install -g @anthropic-ai/claude-code@2.1.236

# The home directory is the reviewer's (/Users/hiiamtrong), so every absolute path in settings, rules and steps means the same here.
# pi-home holds the reviewer's Pi files without credentials: no auth.json, no mcp-env.json.
RUN useradd -u 1000 -d /Users/hiiamtrong -M -s /bin/bash agent && mkdir -p /Users/hiiamtrong && chown 1000:1000 /Users/hiiamtrong
COPY --chown=1000:1000 pi-home/ /Users/hiiamtrong/
USER 1000
ENV HOME=/Users/hiiamtrong
WORKDIR /Users/hiiamtrong
# Pi installs every package in settings.json from its source, as it does on the reviewer's machine.
RUN pi update --extensions
# Then pi-guardrails is replaced by the working tree this image is built from (it holds the unreleased review-pipeline changes).
ENV GUARDRAILS=/Users/hiiamtrong/.pi/agent/git/github.com/hiiamtrong/pi-guardrails
RUN find "$GUARDRAILS" -mindepth 1 -maxdepth 1 ! -name .git ! -name node_modules -exec rm -rf {} +
COPY --chown=1000:1000 pi-guardrails/ /Users/hiiamtrong/.pi/agent/git/github.com/hiiamtrong/pi-guardrails/
RUN cd "$GUARDRAILS" && npm install --omit=dev --ignore-scripts
COPY --chown=1000:1000 agent /opt/agent
ENV ENGINE=/Users/hiiamtrong/.pi/agent/git/github.com/hiiamtrong/pi-guardrails/review-pipeline
