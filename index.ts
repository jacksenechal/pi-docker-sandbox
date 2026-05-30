/**
 * agent-sandbox — lightweight Docker sandbox for pi coding agent.
 *
 * Default: complete isolation (no network, no host mounts).
 * The container has an internal /workspace directory that is always
 * writable, so bash/read/write/edit work even with no mounts.
 *
 * Opt in to networking, CWD mount, skills mount, SSH agent forwarding.
 *
 * Flags:
 *   --no-sandbox          disable sandbox entirely (sandbox is on by default)
 *   --sandbox-network     allow outbound network (needed for browser tool)
 *   --sandbox-mount-cwd   bind-mount the project at /workspace (rw)
 *   --sandbox-mount-skills mount agent skill directories (ro)
 *   --sandbox-mount-ssh   forward $SSH_AUTH_SOCK into the container
 *   --sandbox-name <n>    reusable container name (default: pi-agent-<sid>)
 *   --sandbox-memory <m>  memory limit (default: 4g)
 *   --sandbox-cpus <c>    CPU limit (default: 2)
 *
 * Commands:
 *   /sandbox          show container status and resource usage
 *   /sandbox doctor   verify tools inside the container
 *   /sandbox stop|restart|rebuild|prune
 *   /sandbox network|ssh|cwd|skills on|off
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { statSync, readdirSync } from "node:fs";
import {
  type ExtensionAPI,
  type ExtensionUIContext,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import { createRealDockerClient, createRealProcessRunner, q } from "./docker";
import { SandboxManager } from "./sandbox";
import { ToggleStore } from "./toggles";
import { createReadOps, createWriteOps, createEditOps, createBashOps } from "./tools";
import type { FileStore, SkillResolver, SandboxFlags, UIContext } from "./types";

// ── Constants ────────────────────────────────────────────────────────────

const LOG_FILE = "/tmp/agent-sandbox.log";

function log(msg: string) {
  try { writeFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch {}
}

// ── File I/O (real implementation of FileStore) ──────────────────────────

const fileStore: FileStore = {
  read(path: string): string | null {
    try { return existsSync(path) ? readFileSync(path, "utf-8") : null; } catch { return null; }
  },
  write(path: string, data: string): void {
    try { writeFileSync(path, data); } catch {}
  },
  exists(path: string): boolean {
    return existsSync(path);
  },
};

// ── Session ID ───────────────────────────────────────────────────────────

function getSessionId(): string {
  const file = `/tmp/agent-sandbox-session-${process.pid}.json`;
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")).id;
  } catch {}
  const id = randomUUID().slice(0, 8);
  try { writeFileSync(file, JSON.stringify({ id, pid: process.pid })); } catch {}
  return id;
}

// ── Skill discovery (real implementation of SkillResolver) ───────────────

const skillResolver: SkillResolver = {
  discover(): string[] {
    const roots = [
      pathJoin(homedir(), ".agents", "skills"),
      pathJoin(homedir(), ".pi", "agent", "skills"),
    ];
    const dirs: string[] = [];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        for (const entry of readdirSync(root)) {
          const full = pathJoin(root, entry);
          try {
            if (statSync(full).isDirectory() && !dirs.includes(full)) dirs.push(full);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    return dirs;
  },
};

// ── Extension directory (for rebuild command) ────────────────────────────

function getExtensionDir(): string {
  const candidates = [
    resolvePath(homedir(), "workspace", "agent-sandbox"),
    resolvePath(homedir(), ".pi", "agent", "extensions", "sandbox"),
  ];
  for (const dir of candidates) {
    if (existsSync(pathJoin(dir, "Dockerfile"))) return dir;
  }
  throw new Error("Cannot find agent-sandbox Dockerfile.");
}

// ── Browser tool ─────────────────────────────────────────────────────────

function createBrowserTool(manager: SandboxManager) {
  return {
    name: "browser",
    label: "Browser (sandboxed)",
    description: "Navigate the web using a headless Chromium browser (Playwright). Use when you need to view a webpage, click elements, fill forms, or extract content.",
    promptSnippet: "Navigate and interact with web pages using Playwright",
    promptGuidelines: [
      "Use the browser tool to view web pages, interact with elements, and extract page content.",
      "The browser runs headless inside the sandbox container. All navigation is isolated.",
      "Write the full Playwright script — the tool executes it as `node -e '<script>'`.",
      "Use `page.goto(url)` to navigate, `page.content()` or `page.locator(…).textContent()` to extract text.",
    ],
    parameters: null as any,
    async execute(
      _toolCallId: string,
      params: { script: string },
      _signal: AbortSignal,
      onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
      _ctx: any,
    ) {
      onUpdate?.({ content: [{ type: "text", text: "Running browser script…" }] });
      try {
        const result = await manager.exec(`node -e ${q(params.script)}`, 30000);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Browser error: ${e.message}` }], details: {}, isError: true };
      }
    },
  };
}

// ── Extension entry point ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  log("extension loading…");

  // ── Flags ───────────────────────────────────────────────────────────

  pi.registerFlag("sandbox", {
    description: "Run tools inside a Docker sandbox (default: on)",
    type: "boolean", default: true,
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable the Docker sandbox",
    type: "boolean", default: false,
  });
  pi.registerFlag("sandbox-network", {
    description: "Allow outbound network from the sandbox",
    type: "boolean", default: false,
  });
  pi.registerFlag("sandbox-mount-cwd", {
    description: "Mount the project directory at /workspace (rw)",
    type: "boolean", default: false,
  });
  pi.registerFlag("sandbox-mount-skills", {
    description: "Mount agent skill directories (ro)",
    type: "boolean", default: false,
  });
  pi.registerFlag("sandbox-mount-ssh", {
    description: "Forward SSH agent socket into the container",
    type: "boolean", default: false,
  });
  pi.registerFlag("sandbox-name", {
    description: "Reusable container name (default: auto-generated)",
    type: "string",
  });
  pi.registerFlag("sandbox-memory", {
    description: "Memory limit (default: 4g)",
    type: "string", default: "4g",
  });
  pi.registerFlag("sandbox-cpus", {
    description: "CPU limit (default: 2)",
    type: "string", default: "2",
  });

  const localCwd = process.cwd();
  log(`localCwd=${localCwd}`);

  // ── Toggle store ─────────────────────────────────────────────────────

  const getToggleStore = (() => {
    let store: ToggleStore | null = null;
    return () => {
      if (!store) {
        store = new ToggleStore(fileStore, `/tmp/agent-sandbox-toggles-${getSessionId()}.json`);
      }
      return store;
    };
  })();

  // ── Snapshot host tools for fallback ─────────────────────────────────

  const hostRead = createReadTool(localCwd);
  const hostWrite = createWriteTool(localCwd);
  const hostEdit = createEditTool(localCwd);
  const hostBash = createBashTool(localCwd);

  // ── Module state ─────────────────────────────────────────────────────

  let manager: SandboxManager | null = null;
  let browserToolRegistered = false;

  function getManager(): SandboxManager | null {
    return manager;
  }

  // ── Tool overrides ───────────────────────────────────────────────────

  pi.registerTool({
    ...hostRead,
    async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
      const m = getManager();
      if (!m) return hostRead.execute(id, params, signal, onUpdate);
      const tool = createReadTool(localCwd, { operations: createReadOps(m) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...hostWrite,
    async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
      const m = getManager();
      if (!m) return hostWrite.execute(id, params, signal, onUpdate);
      const tool = createWriteTool(localCwd, { operations: createWriteOps(m) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...hostEdit,
    async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
      const m = getManager();
      if (!m) return hostEdit.execute(id, params, signal, onUpdate);
      const tool = createEditTool(localCwd, { operations: createEditOps(m) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...hostBash,
    label: "bash (sandboxed)",
    async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
      const m = getManager();
      if (!m) return hostBash.execute(id, params, signal, onUpdate);
      const tool = createBashTool(localCwd, { operations: createBashOps(m) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // ── Browser tool (registered when network is enabled) ────────────────

  function ensureBrowserTool(m: SandboxManager) {
    if (browserToolRegistered || !m.hasNetwork) return;
    const { Type } = require("typebox");
    const tool = createBrowserTool(m);
    tool.parameters = Type.Object({
      script: Type.String({ description: "Playwright Node.js script to execute. Use `const { chromium } = require('playwright');` at the start." }),
    });
    pi.registerTool(tool as any);
    browserToolRegistered = true;
  }

  // ── User bash override ──────────────────────────────────────────────

  pi.on("user_bash", () => {
    const m = getManager();
    if (!m) return;
    return { operations: createBashOps(m) };
  });

  // ── System prompt injection ─────────────────────────────────────────

  pi.on("before_agent_start", (event) => {
    const m = getManager();
    if (!m) return;
    return { systemPrompt: m.injectIntoPrompt(event.systemPrompt) };
  });

  // ── Container lifecycle ─────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    log(`session_start flags: sandbox=${pi.getFlag("sandbox")}`);

    if ((pi.getFlag("no-sandbox") as boolean) || !(pi.getFlag("sandbox") as boolean)) {
      log("sandbox disabled via flag, skipping");
      return;
    }

    try {
      const toggles = getToggleStore();
      const docker = createRealDockerClient(createRealProcessRunner());

      const hasNetwork = toggles.get("network") ?? (pi.getFlag("sandbox-network") as boolean);
      const hasCwd = toggles.get("cwd") ?? (pi.getFlag("sandbox-mount-cwd") as boolean);
      const hasSkills = toggles.get("skills") ?? (pi.getFlag("sandbox-mount-skills") as boolean);
      const hasSsh = toggles.get("ssh") ?? (pi.getFlag("sandbox-mount-ssh") as boolean);

      const flags: SandboxFlags = {
        network: hasNetwork,
        mountCwd: hasCwd,
        mountSkills: hasSkills,
        mountSsh: hasSsh,
        containerName: pi.getFlag("sandbox-name") as string | undefined,
        memory: (pi.getFlag("sandbox-memory") as string) || "4g",
        cpus: (pi.getFlag("sandbox-cpus") as string) || "2",
      };

      log(`flags: network=${hasNetwork} cwd=${hasCwd} skills=${hasSkills} ssh=${hasSsh}`);

      const sessionId = getSessionId();
      const m = await SandboxManager.start({
        docker,
        skillResolver,
        hostCwd: localCwd,
        sessionId,
        flags,
        containerName: flags.containerName,
      });

      if (!m) {
        ctx.ui.notify("Failed to start sandbox container. Running without sandbox.", "warning");
        return;
      }

      manager = m;

      // Status display.
      const flagParts: string[] = [];
      if (m.hasNetwork) flagParts.push("net");
      if (m.hasCwd) flagParts.push("cwd");
      if (m.hasSkills) flagParts.push("skills");
      if (m.hasSsh) flagParts.push("ssh");
      const flagStr = flagParts.length ? ` [${flagParts.join(", ")}]` : " [isolated]";

      ctx.ui.setStatus("sandbox", `🛡 ${m.name}${flagStr} mem=${m.memory} cpu=${m.cpus}`);
      ctx.ui.notify(
        `🛡 Sandbox up: ${m.name}${flagStr}\nnode /workspace\nmemory=${m.memory} cpu=${m.cpus} network=${m.hasNetwork ? "on" : "off"} cwd=${m.hasCwd ? "mounted" : "none"} skills=${m.hasSkills ? "mounted" : "none"} ssh=${m.hasSsh ? "forwarded" : "none"}`,
        "info",
      );

      ensureBrowserTool(m);
      log(`session_start complete, sandbox active`);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`session_start ERROR: ${msg}`);
      manager = null;
      ctx.ui.notify(`Sandbox init failed: ${msg}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    const m = getManager();
    if (!m) return;
    await m.stop();
    manager = null;
  });

  // ── /sandbox command ────────────────────────────────────────────────

  function buildFlagString(m: SandboxManager): string {
    const parts: string[] = [];
    if (m.hasNetwork) parts.push("network");
    if (m.hasCwd) parts.push("cwd");
    if (m.hasSkills) parts.push("skills");
    if (m.hasSsh) parts.push("ssh-agent");
    return parts.length ? parts.join(", ") : "fully isolated";
  }

  async function toggleFeature(
    feature: string,
    enable: boolean,
    ctx: ExtensionUIContext,
    confirmation: string,
  ): Promise<void> {
    if (!(await ctx.ui.confirm(
      enable ? `Enable ${feature}?` : `Disable ${feature}?`,
      confirmation,
    ))) return;

    getToggleStore().set(feature, enable);
    ctx.ui.notify(`${feature} ${enable ? "enabled" : "disabled"}. Restarting sandbox…`, "info");
    const m = getManager();
    if (m) { await m.stop(); manager = null; }
    await ctx.reload();
  }

  pi.registerCommand("sandbox", {
    description: "Sandbox management. status, doctor, stop, restart, rebuild, prune, network/ssh/cwd/skills on|off",
    handler: async (args: string, ctx: ExtensionUIContext) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || "status";
      const action = parts[1]?.toLowerCase();

      switch (sub) {
        case "status": {
          const m = getManager();
          if (!m) {
            ctx.ui.notify("Sandbox is not active.", "info");
            return;
          }
          try {
            const info = await m.exec("id && uname -a && df -h / 2>/dev/null | tail -1");
            const toggles = getToggleStore().getAll();
            const toggleStr = Object.keys(toggles).length
              ? " | toggles: " + Object.entries(toggles).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(" ")
              : "";
            ctx.ui.notify([
              `🛡 Sandbox: ${m.name}`,
              `Flags: ${buildFlagString(m)}${toggleStr}`,
              `Resources: memory=${m.memory}, cpus=${m.cpus}`,
              `Host CWD: ${m.hostCwd}`,
              "",
              info,
            ].join("\n"), "info");
          } catch (e: any) {
            ctx.ui.notify(`Sandbox error: ${e.message}`, "error");
          }
          break;
        }
        case "doctor": {
          const m = getManager();
          if (!m) { ctx.ui.notify("Sandbox is not active.", "info"); return; }
          const script = [
            'for cmd in sh bash node npm git rg fd jq curl ssh chromium; do',
            '  if command -v "$cmd" >/dev/null 2>&1; then printf "  ok   %-12s -> %s\\n" "$cmd" "$(command -v "$cmd")"; else printf "  MISS %-12s\\n" "$cmd"; fi',
            "done",
            "echo",
            'node --version 2>&1 | sed "s/^/  node version: /"',
            'chromium --version 2>&1 | sed "s/^/  chromium: /"',
            '[ -f /usr/local/lib/node_modules/playwright/package.json ] && echo "  playwright: installed" || echo "  playwright: MISSING"',
          ].join("\n");
          try {
            const out = await m.exec(script, 20000);
            ctx.ui.notify(`Sandbox doctor:\n${out}`, "info");
          } catch (e: any) {
            ctx.ui.notify(`Doctor failed: ${e.message}`, "error");
          }
          break;
        }
        case "network": {
          if (action === "on" || action === "off") {
            await toggleFeature("network", action === "on", ctx,
              "This will allow the sandbox to make outbound connections. The browser tool will become available.");
          } else {
            ctx.ui.notify("Usage: /sandbox network on|off", "info");
          }
          break;
        }
        case "ssh": {
          if (action === "on" || action === "off") {
            if (action === "on" && !process.env.SSH_AUTH_SOCK) {
              ctx.ui.notify("SSH_AUTH_SOCK is not set. SSH agent forwarding won't work.", "warning");
            }
            await toggleFeature("ssh", action === "on", ctx,
              action === "on"
                ? "Forward the host SSH agent into the sandbox. Git over SSH will use your keys."
                : "Remove SSH agent access. Git over SSH will stop working.");
          } else {
            ctx.ui.notify("Usage: /sandbox ssh on|off", "info");
          }
          break;
        }
        case "cwd": {
          if (action === "on" || action === "off") {
            await toggleFeature("cwd", action === "on", ctx,
              action === "on"
                ? `Mount ${process.cwd()} at /workspace (read-write).`
                : "Unmount the project directory. /workspace will become ephemeral.");
          } else {
            ctx.ui.notify("Usage: /sandbox cwd on|off", "info");
          }
          break;
        }
        case "skills": {
          if (action === "on" || action === "off") {
            getToggleStore().set("skills", action === "on");
            ctx.ui.notify(`Skills mount ${action === "on" ? "enabled" : "disabled"}. Restarting sandbox…`, "info");
            const m = getManager();
            if (m) { await m.stop(); manager = null; }
            await ctx.reload();
          } else {
            ctx.ui.notify("Usage: /sandbox skills on|off", "info");
          }
          break;
        }
        case "stop":
        case "kill":
        case "restart": {
          const m = getManager();
          const name = m?.name;
          if (m) { await m.stop(); manager = null; }
          if (sub === "restart" || !name) {
            ctx.ui.notify(name ? `Sandbox ${name} killed. Reconnecting…` : "Starting new sandbox…", "info");
            await ctx.reload();
          } else {
            ctx.ui.notify(`Sandbox ${name} stopped.`, "info");
          }
          break;
        }
        case "rebuild": {
          ctx.ui.notify("Rebuilding sandbox image…");
          try {
            const docker = createRealDockerClient(createRealProcessRunner());
            const { ok, stdout, stderr } = await docker.build(getExtensionDir(), "agent-sandbox:latest");
            if (ok) {
              ctx.ui.notify(`Sandbox image rebuilt.\n${stdout.slice(-500)}`, "info");
            } else {
              ctx.ui.notify(`Rebuild failed:\n${stderr.slice(-1000) || stdout.slice(-1000)}`, "error");
            }
          } catch (e: any) {
            ctx.ui.notify(`Rebuild error: ${e.message}`, "error");
          }
          break;
        }
        case "prune": {
          try {
            const docker = createRealDockerClient(createRealProcessRunner());
            const m = getManager();
            const { stdout } = await docker.run(["ps", "-a", "--filter", "name=pi-agent-", "--format", "{{.Names}}"], 5000);
            const names = stdout.trim().split("\n").filter(Boolean);
            if (names.length === 0) {
              ctx.ui.notify("No sandbox containers found.", "info");
              break;
            }
            let removed = 0;
            for (const name of names) {
              if (name === m?.name) continue;
              await docker.rm(name);
              removed++;
            }
            ctx.ui.notify(`Pruned ${removed} stopped sandbox container${removed !== 1 ? "s" : ""}.`, "info");
          } catch (e: any) {
            ctx.ui.notify(`Prune error: ${e.message}`, "error");
          }
          break;
        }
        default:
          ctx.ui.notify(`Unknown subcommand: ${sub}\nTry: status, doctor, stop, restart, rebuild, prune, network, ssh, cwd, skills`, "info");
      }
    },
  });

  log("extension loaded successfully");
}
