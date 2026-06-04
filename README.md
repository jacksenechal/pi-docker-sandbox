# pi-docker-sandbox

Lightweight Docker sandbox for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

**Default: complete isolation.** No network, no host filesystem. The agent runs in an empty container with Chromium, Playwright, Node 22, git, and essential CLI tools.

## Quick start

```bash
# Install the extension
pi install npm:pi-docker-sandbox

# Build the sandbox image (once)
docker build -t agent-sandbox:latest .

# Start pi — sandbox is on by default
pi
```

## Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--no-sandbox` | — | Disable sandbox entirely |
| `--sandbox-network` | off | Allow outbound network (enables `browser` tool); host dev servers reachable at `host.docker.internal:<port>` |
| `--sandbox-host-network` | off | Run container with `--network host` so `localhost` inside the container maps to the host. Implies network on. Note: reduces isolation and shares the host port space, so parallel sandboxes cannot each bind the same port; for parallel work prefer bridge + `host.docker.internal`. |
| `--sandbox-mount-cwd` | off | Mount the project at `/workspace` (rw) |
| `--sandbox-mount-skills` | off | Mount agent skill directories at `/skills` (ro) |
| `--sandbox-mount-ssh` | off | Forward `$SSH_AUTH_SOCK` for git over SSH |
| `--sandbox-memory` | `4g` | Memory limit |
| `--sandbox-cpus` | `2` | CPU limit |
| `--sandbox-name` | auto | Reusable container name |

## Commands

| Command | Purpose |
|---------|---------|
| `/sandbox` | Show container status, flags, and resource usage |
| `/sandbox doctor` | Verify tools inside the container |
| `/sandbox stop` | Stop the sandbox container |
| `/sandbox restart` | Restart the sandbox container |
| `/sandbox rebuild` | Rebuild the sandbox Docker image |
| `/sandbox prune` | Remove all stopped `pi-agent-*` containers |
| `/sandbox network on\|off` | Toggle outbound network access (bridge; `host.docker.internal` reaches host) |
| `/sandbox host-network on\|off` | Toggle host networking (`localhost` inside container reaches host; reduces isolation) |
| `/sandbox ssh on\|off` | Toggle SSH agent forwarding |
| `/sandbox cwd on\|off` | Toggle project CWD mount |
| `/sandbox skills on\|off` | Toggle skill directory mounts |

Toggles (`network`, `ssh`, `cwd`, `skills`) persist across reloads and
require a container restart to take effect.

## Architecture

```
pi starts
  └─ session_start → SandboxManager.start()
       ├─ docker run agent-sandbox:latest
       ├─ Proxy read/write/edit/bash via docker exec
       ├─ Inject system prompt with sandbox state
       └─ Register cleanup on SIGINT/SIGTERM/exit
  └─ session_shutdown → SandboxManager.stop()
```

### Module structure

| Module | Responsibility |
|--------|---------------|
| `types.ts` | Interfaces: `DockerClient`, `FileStore`, `SandboxHandle`, `UIContext`, … |
| `docker.ts` | Docker CLI abstraction (`q`, `createRealDockerClient`, `stopSync`) |
| `path-translation.ts` | `toRemote()` — host→container path mapping |
| `prompt.ts` | `buildSystemPrompt()` — sandbox status for agent system prompt |
| `toggles.ts` | `ToggleStore` — persisted feature toggles (survives `ctx.reload()`) |
| `sandbox.ts` | `SandboxManager` — container lifecycle, exec, path translation |
| `tools.ts` | `createReadOps`, `createWriteOps`, `createBashOps` — tool adapters |
| `commands.ts` | `/sandbox` subcommand routing (`handleSandboxCommand`) |
| `index.ts` | Extension entry point — flags, tool registration, event wiring |

## Image contents

- **Chromium** (system package) + **Playwright** (preconfigured, no browser download)
- **Node 22 LTS** (from `node:22-bookworm-slim`)
- **git**, **curl**, **jq**, **ripgrep**, **fd**, **openssh-client**
- Non-root `node` user (uid 1000)

## Companion extensions

For a complete web research setup, pair this sandbox with:

- [pi-webai](https://pi.dev/packages/pi-webaio) — web browsing and AI-powered extraction
- [pi-textbrowser](https://pi.dev/packages/pi-textbrowser) — lightweight text-mode browser
- [pi-smart-fetch](https://pi.dev/packages/pi-smart-fetch) — intelligent content fetching

All three run inside the sandbox when network is enabled (`--sandbox-network`).

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npx tsc --noEmit
```