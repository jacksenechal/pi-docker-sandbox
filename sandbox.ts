import { toRemote as translatePath } from "./path-translation";
import { buildSystemPrompt } from "./prompt";
import type { PromptContext } from "./prompt";
import type { DockerClient, PathContext, SandboxFlags, SkillResolver } from "./types";

const IMAGE = "agent-sandbox:latest";
const REMOTE_WORKSPACE = "/workspace";
const REMOTE_SKILLS = "/home/node/.agent/skills";

// ── Container name derivation ─────────────────────────────────────────────

function deriveName(sessionId: string): string {
  return `pi-agent-${sessionId}`;
}

// ── SandboxManager ────────────────────────────────────────────────────────

export class SandboxManager {
  readonly name: string;
  readonly hostCwd: string;
  readonly hasCwd: boolean;
  readonly hasNetwork: boolean;
  readonly hasSkills: boolean;
  readonly hasSsh: boolean;
  readonly memory: string;
  readonly cpus: string;
  readonly skillSources: string[];

  private constructor(
    private docker: DockerClient,
    private skillResolver: SkillResolver,
    opts: {
      name: string;
      hostCwd: string;
      flags: SandboxFlags;
      skillSources: string[];
    },
  ) {
    this.name = opts.name;
    this.hostCwd = opts.hostCwd;
    this.hasCwd = opts.flags.mountCwd;
    this.hasNetwork = opts.flags.network;
    this.hasSkills = opts.flags.mountSkills;
    this.hasSsh = opts.flags.mountSsh;
    this.memory = opts.flags.memory;
    this.cpus = opts.flags.cpus;
    this.skillSources = opts.skillSources;
  }

  // ── Factory ───────────────────────────────────────────────────────

  static async start(opts: {
    docker: DockerClient;
    skillResolver: SkillResolver;
    hostCwd: string;
    sessionId: string;
    flags: SandboxFlags;
    containerName?: string;
  }): Promise<SandboxManager | null> {
    const { docker, skillResolver, hostCwd, sessionId, flags } = opts;

    // Check Docker is available.
    const haveDocker = await docker.version();
    if (!haveDocker) return null;

    // Ensure image exists.
    const imageExists = await docker.imageExists(IMAGE);
    if (!imageExists) {
      const pulled = await docker.pull(IMAGE);
      if (!pulled) return null;
    }

    const containerName = opts.containerName || deriveName(sessionId);

    // Remove any stale container with the same name.
    await docker.rm(containerName);

    // Discover skill directories.
    const skillSources: string[] = flags.mountSkills ? skillResolver.discover() : [];

    // Build docker run args.
    const args = SandboxManager.buildRunArgs({
      name: containerName,
      hostCwd,
      flags: { ...flags, mountSkills: flags.mountSkills && skillSources.length > 0 ? flags.mountSkills : false },
      skillSources,
    });

    // Start the container.
    const { ok: started, stderr: runErr } = await docker.run([
      "run", "-d", "--rm", ...args, IMAGE, "sleep", "infinity",
    ], 60000);

    if (!started) return null;

    const manager = new SandboxManager(docker, skillResolver, {
      name: containerName,
      hostCwd,
      flags,
      skillSources,
    });

    // Register cleanup on process signals.
    const cleanup = () => {
      const { stopSync } = require("./docker") as typeof import("./docker");
      stopSync(manager.name);
    };
    process.once("exit", cleanup);
    process.once("SIGINT", () => { cleanup(); process.exit(130); });
    process.once("SIGTERM", () => { cleanup(); process.exit(143); });

    // Smoke test.
    await manager.exec("id -un && pwd", 10000);

    return manager;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async stop(): Promise<void> {
    await this.docker.stop(this.name);
  }

  // ── Operations ─────────────────────────────────────────────────────

  async exec(cmd: string, timeoutMs = 30000): Promise<string> {
    return this.docker.exec(this.name, cmd, timeoutMs);
  }

  toRemote(hostPath: string): string {
    return translatePath(hostPath, this.getPathContext());
  }

  // ── Prompt integration ─────────────────────────────────────────────

  getPromptContext(): PromptContext {
    return {
      name: this.name,
      hasCwd: this.hasCwd,
      hasNetwork: this.hasNetwork,
      hasSkills: this.hasSkills,
      hasSsh: this.hasSsh,
      hostCwd: this.hostCwd,
    };
  }

  injectIntoPrompt(systemPrompt: string): string {
    return systemPrompt.replace(
      `Current working directory: ${this.hostCwd}`,
      buildSystemPrompt(this.getPromptContext()),
    );
  }

  // ── Path context ───────────────────────────────────────────────────

  private getPathContext(): PathContext {
    return {
      hostCwd: this.hostCwd,
      hasCwd: this.hasCwd,
      hasSkills: this.hasSkills,
      skillSources: this.skillSources,
    };
  }

  // ── Docker arg building ────────────────────────────────────────────

  private static buildRunArgs(opts: {
    name: string;
    hostCwd: string;
    flags: SandboxFlags;
    skillSources: string[];
  }): string[] {
    const { name, hostCwd, flags, skillSources } = opts;
    const args: string[] = [
      "--name", name,
      "--user", "1000:1000",
      "--memory", flags.memory,
      "--cpus", flags.cpus,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "512",
    ];

    if (!flags.network) {
      args.push("--network", "none");
    }

    if (flags.mountCwd) {
      args.push("-v", `${hostCwd}:${REMOTE_WORKSPACE}`);
    }

    if (flags.mountSkills) {
      for (const dir of skillSources) {
        const name = dir.split("/").filter(Boolean).pop() || "unknown";
        args.push("-v", `${dir}:${REMOTE_SKILLS}/${name}:ro`);
      }
    }

    if (flags.mountSsh && process.env.SSH_AUTH_SOCK) {
      const sock = process.env.SSH_AUTH_SOCK;
      args.push("-v", `${sock}:${sock}`);
      args.push("-e", `SSH_AUTH_SOCK=${sock}`);
    }

    return args;
  }
}
