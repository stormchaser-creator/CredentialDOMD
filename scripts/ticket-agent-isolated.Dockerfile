# Supply an independently reviewed, digest-pinned Node 24 Debian image.
# Example shape: node:24-bookworm-slim@sha256:<reviewed digest>
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
# The installed host CLI verified during this change was 2.1.221. Pin the
# container CLI separately; update only after the isolation canary below passes.
ARG CLAUDE_VERSION=2.1.221
RUN npm install --global --ignore-scripts @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force
ENV HOME=/tmp/worker-home CLAUDE_CONFIG_DIR=/tmp/worker-config
WORKDIR /work
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/claude"]
