# Agent sandbox — self-contained image for parallel research agents
#
# Unlike pi's default tool-sandbox (where pi runs on the HOST and only proxies
# bash/read/write/edit into the container via `docker exec`), this image bakes in
# pi ITSELF plus its research extensions and a Playwright browser. That lets the
# ENTIRE pi worker — including pi-webaio's headless Chromium — run inside the
# container. Nothing touches the host browser or host filesystem.
#
# Goals:
#   - pi coding agent + research extensions (pi-webaio web search/fetch + browser)
#   - A real Playwright Chromium installed in-image (no host Chrome dependency)
#   - Node 22 LTS runtime
#   - git + SSH for repository operations (agent forwarding, no key files)
#   - Essential CLI tools (curl, jq, ripgrep, fd)
#   - Non-root `node` user (uid 1000, matches typical host user)
#
# Build:
#   docker build -t agent-sandbox:latest .
#
# Run one research worker (see skills/pi-swarm/scripts/pi-research.sh):
#   docker run --rm -e OPENCODE_API_KEY=... agent-sandbox:latest \
#     pi -p --no-session --model opencode-go/glm-5.1 "research ..."

FROM node:22-bookworm-slim

# Pin pi to the host orchestrator's version to avoid drift between the brain
# (host Claude → host pi version) and the hands (this image). Bump deliberately.
ARG PI_VERSION=0.78.1

# ── System packages ─────────────────────────────────────────────────
# chromium: NOT launched directly — pi-webaio drives its own Playwright browser
#   (installed below). We install the apt package only to pull in the shared
#   libraries and fonts that Playwright's bundled Chromium needs at runtime; it
#   is the cheapest way to satisfy that native dependency closure.
# ripgrep fd-find jq git curl: research agent toolkit.
# openssh-client: for SSH agent forwarding (git over SSH).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        ripgrep \
        fd-find \
        jq \
        git \
        curl \
        ca-certificates \
        openssh-client \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# ── pi coding agent (global) ─────────────────────────────────────────
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}

# ── SSH setup for agent forwarding ────────────────────────────────────
# Create ~/.ssh/config so git over SSH works out of the box when the host
# forwards its SSH agent socket. accept-new: auto-add host keys on first
# contact, verify on subsequent.
RUN mkdir -p /home/node/.ssh \
 && echo "Host *" > /home/node/.ssh/config \
 && echo "    StrictHostKeyChecking accept-new" >> /home/node/.ssh/config \
 && chown -R node:node /home/node/.ssh

# ── Workspace + non-root user ─────────────────────────────────────────
# The node image already provides `node` (uid 1000), matching the host user, so
# bind mounts line up without uid juggling.
RUN mkdir -p /workspace /home/node/.agent/skills /home/node/.pi \
 && chown -R node:node /workspace /home/node/.agent /home/node/.pi

USER node
ENV HOME=/home/node

# ── pi research extensions ────────────────────────────────────────────
# Each `pi install` adds the package to ~/.pi/agent/npm and records it in
# ~/.pi/agent/settings.json `packages`, so it auto-loads at runtime. pi-webaio
# provides web search/fetch + the `browser` tool (and the Playwright that drives
# it). Run as the `node` user so everything lands under /home/node/.pi.
RUN pi install npm:pi-webaio \
 && pi install npm:pi-lens \
 && pi install npm:pi-textbrowser \
 && pi install npm:pi-smart-fetch

# ── Playwright browser (matches pi-webaio's bundled Playwright) ────────
# Use pi-webaio's own Playwright to install the exact matching Chromium build
# into node's browser cache. This is what makes the `browser` tool launch a real
# headless Chromium INSIDE the container: pi-webaio tries channel:"chrome" first
# (no system Google Chrome here, so that fails fast) then falls back to this
# bundled browser. Baking it in means workers never reach for a host browser.
RUN node /home/node/.pi/agent/npm/node_modules/playwright/cli.js install chromium

WORKDIR /workspace

# Default to idle so the image can also be run as a long-lived container; the
# pi-swarm wrapper overrides the command with `pi -p ...` per worker.
CMD ["sleep", "infinity"]
