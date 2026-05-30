# Agent sandbox — minimal, fast-build image for parallel research agents
#
# Goals:
#   - Chromium + Playwright for browser automation (headless)
#   - Node 22 LTS runtime
#   - git + SSH for repository operations (agent forwarding, no key files)
#   - Essential CLI tools (curl, jq, ripgrep, fd)
#   - Non-root `node` user (uid 1000, matches typical host user)
#   - ~2 minute build, small layer count, caches well
#
# Build:
#   docker build -t agent-sandbox:latest .
#
# Usage:
#   pi (with sandbox extension loaded)
#   docker run -d --name agent-test agent-sandbox:latest sleep infinity

FROM node:22-bookworm-slim

# ── System packages ─────────────────────────────────────────────────
# chromium: full browser for Playwright (no separate download needed)
# ripgrep fd-find jq git curl: research agent toolkit
# openssh-client: for SSH agent forwarding (git over SSH)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        chromium \
        ripgrep \
        fd-find \
        jq \
        git \
        curl \
        ca-certificates \
        openssh-client \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# fd is named fdfind in Debian — symlink for convenience
RUN ln -s /usr/bin/fdfind /usr/local/bin/fd

# ── Playwright (system chromium, no browser download) ────────────────
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright

# ── SSH setup for agent forwarding ────────────────────────────────────
# Create ~/.ssh/config so git over SSH works out of the box when the
# host forwards its SSH agent socket (--sandbox-mount-ssh).
# accept-new: auto-add host keys on first contact, verify on subsequent.
RUN mkdir -p /home/node/.ssh \
 && echo "Host *" > /home/node/.ssh/config \
 && echo "    StrictHostKeyChecking accept-new" >> /home/node/.ssh/config \
 && chown -R node:node /home/node/.ssh

# ── Non-root user ────────────────────────────────────────────────────
# The node image already provides `node` user with uid 1000, matching
# the host user. Reuse it to avoid uid collision on mounts.
RUN mkdir -p /workspace /home/node/.agent/skills && chown node:node /workspace /home/node/.agent/skills

USER node
WORKDIR /workspace

CMD ["sleep", "infinity"]