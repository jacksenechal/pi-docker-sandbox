# agent-sandbox

Lightweight Docker sandbox for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

**Default: complete isolation.** No network, no host filesystem. The agent runs in an empty container with Chromium, Playwright, Node 22, git, and essential CLI tools.

## Quick start

```bash
# Build the sandbox image (once)
docker build -t agent-sandbox:latest .

# Link the extension into your project
ln -s /home/jack/workspace/agent-sandbox /home/jack/workspace/jobs/.pi/extensions/sandbox

# Start pi — sandbox is on by default
pi
```

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--no-sandbox` | — | Disable sandbox entirely |
| `--sandbox-network` | off | Allow outbound network (enables `browser` tool) |
| `--sandbox-mount-cwd` | off | Mount the project at `/workspace` (rw) |
| `--sandbox-mount-skills` | off | Mount agent skill directories at `/skills` (ro) |
| `--sandbox-mount-ssh` | off | Forward `$SSH_AUTH_SOCK` for git over SSH |
| `--sandbox-memory` | `4g` | Memory limit |
| `--sandbox-cpus` | `2` | CPU limit |
| `--sandbox-name` | auto | Reusable container name |

## Commands

| Command | Purpose |
|---------|---------|
| `/sandbox` | Show container status and resource usage |
| `/sandbox doctor` | Verify tools inside the container |
| `/sandbox stop` | Stop the sandbox container |

## Image contents

- **Chromium** (system package) + **Playwright** (preconfigured, no browser download)
- **Node 22 LTS** (from `node:22-bookworm-slim`)
- **git**, **curl**, **jq**, **ripgrep**, **fd**, **openssh-client**
- Non-root `node` user (uid 1000)

## Architecture

```
pi starts
  └─ session_start → docker run agent-sandbox:latest
       ├─ Proxy read/write/edit/bash via docker exec
       ├─ Inject system prompt with sandbox state
       └─ session_shutdown → docker rm -f
```
