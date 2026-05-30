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
import { handleSandboxCommand } from "./commands";
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

  // ── /sandbox command (delegates to commands.ts) ────────────────────

  pi.registerCommand("sandbox", {
    description: "Sandbox management. status, doctor, stop, restart, rebuild, prune, network/ssh/cwd/skills on|off",
    handler: async (args: string, ctx: ExtensionUIContext) => {
      // Compose ctx.ui + ctx.reload into our UIContext interface
      const ui: UIContext = {
        notify: (msg, severity) => ctx.ui.notify(msg, severity),
        confirm: (title, body) => ctx.ui.confirm(title, body),
        setStatus: (key, text) => ctx.ui.setStatus(key, text),
        reload: () => ctx.reload(),
      };
      await handleSandboxCommand(args, ui, getManager, getToggleStore, getExtensionDir);
    },
  });

  log("extension loaded successfully");
}