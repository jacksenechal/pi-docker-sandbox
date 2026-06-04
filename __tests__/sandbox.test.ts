import { describe, it, expect, beforeEach, vi } from "vitest";
import { SandboxManager } from "../sandbox";
import type { DockerClient, DockerResult, SkillResolver, SandboxFlags, ProcessRunner } from "../types";
import { createRealDockerClient } from "../docker";

// ── Fake DockerClient ─────────────────────────────────────────────────────

function ok(stdout = ""): DockerResult {
  return { ok: true, stdout, stderr: "" };
}

function fail(stderr = "error"): DockerResult {
  return { ok: false, stdout: "", stderr };
}

class SpyDockerClient implements DockerClient {
  public runCalls: Array<{ args: string[]; timeoutMs?: number }> = [];
  private runResponses: DockerResult[] = [];

  nextRun(result: DockerResult) { this.runResponses.push(result); }

  async run(args: string[], timeoutMs?: number): Promise<DockerResult> {
    this.runCalls.push({ args, timeoutMs });
    return this.runResponses.shift() ?? fail("no response queued");
  }
  public stopCalls: string[] = [];
  public rmCalls: string[] = [];

  async exec(c: string, cmd: string, _t?: number): Promise<string> {
    this.runCalls.push({ args: ["exec", c, "sh", "-c", cmd] });
    return "output";
  }
  async stop(c: string): Promise<void> { this.stopCalls.push(c); }
  async rm(c: string): Promise<void> { this.rmCalls.push(c); }
  async version(): Promise<boolean> { const r = await this.run(["version"], 5000); return r.ok; }
  async imageExists(i: string): Promise<boolean> { const r = await this.run(["image", "inspect", i], 10000); return r.ok; }
  async pull(i: string): Promise<boolean> { const r = await this.run(["pull", i], 120000); return r.ok; }
  async build(d: string, i: string): Promise<DockerResult> { return this.run(["build", "-t", i, d], 120000); }
}

// ── Fakes ─────────────────────────────────────────────────────────────────

class FakeSkillResolver implements SkillResolver {
  constructor(private dirs: string[] = []) {}
  discover(): string[] { return [...this.dirs]; }
}

const defaultFlags: SandboxFlags = {
  network: false,
  hostNetwork: false,
  mountCwd: false,
  mountSkills: false,
  mountSsh: false,
  memory: "4g",
  cpus: "2",
};

// ── Helpers ───────────────────────────────────────────────────────────────

function startArgs(docker: SpyDockerClient): string[] {
  // The "docker run" call is the first run call after version/image checks
  const runCall = docker.runCalls.find(c => c.args[0] === "run");
  return runCall?.args ?? [];
}

async function startManager(overrides: {
  flags?: Partial<SandboxFlags>;
  hostCwd?: string;
  skillDirs?: string[];
  containerName?: string;
  docker?: SpyDockerClient;
} = {}): Promise<{ manager: SandboxManager; docker: SpyDockerClient }> {
  const docker = overrides.docker ?? new SpyDockerClient();
  // Queue success for version + image inspect + run
  docker.nextRun(ok()); // version
  docker.nextRun(ok()); // image inspect
  docker.nextRun(ok()); // run
  const manager = (await SandboxManager.start({
    docker,
    skillResolver: new FakeSkillResolver(overrides.skillDirs),
    hostCwd: overrides.hostCwd ?? "/home/user/project",
    sessionId: "test1234",
    flags: { ...defaultFlags, ...overrides.flags },
    containerName: overrides.containerName,
  })) as SandboxManager;
  return { manager, docker };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("SandboxManager.start", () => {
  it("returns a SandboxManager with correct flag properties", async () => {
    const { manager } = await startManager({
      flags: { network: true, mountCwd: true },
    });
    expect(manager.hasNetwork).toBe(true);
    expect(manager.hasHostNetwork).toBe(false);
    expect(manager.hasCwd).toBe(true);
    expect(manager.hasSkills).toBe(false);
    expect(manager.hasSsh).toBe(false);
    expect(manager.memory).toBe("4g");
    expect(manager.cpus).toBe("2");
    expect(manager.name).toContain("pi-agent-");
  });

  it("uses provided container name when given", async () => {
    const { manager } = await startManager({ containerName: "my-sandbox" });
    expect(manager.name).toBe("my-sandbox");
  });

  it("adds --network none when network is disabled", async () => {
    const { docker } = await startManager({ flags: { network: false } });
    const args = startArgs(docker);
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });

  it("adds --add-host=host.docker.internal:host-gateway when network is enabled (bridge mode)", async () => {
    const { docker } = await startManager({ flags: { network: true } });
    const args = startArgs(docker);
    expect(args).not.toContain("--network");
    expect(args).toContain("--add-host=host.docker.internal:host-gateway");
  });

  it("uses --network host and no --add-host when hostNetwork is enabled", async () => {
    const { docker } = await startManager({ flags: { hostNetwork: true } });
    const args = startArgs(docker);
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("host");
    expect(args).not.toContain("--network none");
    expect(args.some(a => a.startsWith("--add-host"))).toBe(false);
  });

  it("adds CWD volume mount when mountCwd is true", async () => {
    const { docker } = await startManager({
      flags: { mountCwd: true },
      hostCwd: "/home/user/my-project",
    });
    const args = startArgs(docker);
    expect(args).toContain("-v");
    const volIdx = args.indexOf("-v");
    expect(args[volIdx + 1]).toBe("/home/user/my-project:/workspace");
  });

  it("does not add CWD mount when mountCwd is false", async () => {
    const { docker } = await startManager({ flags: { mountCwd: false } });
    const args = startArgs(docker);
    const cwdMount = args.find((_a, i) => args[i] === "-v" && args[i + 1]?.includes(":/workspace"));
    expect(cwdMount).toBeUndefined();
  });

  it("adds skill volume mounts when mountSkills is true", async () => {
    const { docker } = await startManager({
      flags: { mountSkills: true },
      skillDirs: ["/home/user/.agents/skills/my-skill"],
    });
    const args = startArgs(docker);
    expect(args).toContain("-v");
    const volIdx = args.indexOf("-v");
    expect(args[volIdx + 1]).toMatch(/\.agents\/skills\/my-skill:\/home\/node\/\.agent\/skills\/my-skill:ro/);
  });

  it("adds SSH mount when mountSsh is true", async () => {
    // Temporarily set SSH_AUTH_SOCK for this test
    const orig = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-abc/socket";
    try {
      const { docker } = await startManager({ flags: { mountSsh: true } });
      const args = startArgs(docker);
      expect(args).toContain("-v");
      const sockVol = args.find((_a, i) => args[i] === "-v" && args[i + 1]?.includes("/tmp/ssh-abc/socket"));
      expect(sockVol).toBeDefined();
      expect(args).toContain("-e");
      expect(args).toContain("SSH_AUTH_SOCK=/tmp/ssh-abc/socket");
    } finally {
      if (orig) process.env.SSH_AUTH_SOCK = orig; else delete process.env.SSH_AUTH_SOCK;
    }
  });
});

describe("SandboxManager.stop", () => {
  it("kills the container", async () => {
    const docker = new SpyDockerClient();
    docker.nextRun(ok()); // version
    docker.nextRun(ok()); // inspect
    docker.nextRun(ok()); // run
    const manager = (await SandboxManager.start({
      docker,
      skillResolver: new FakeSkillResolver(),
      hostCwd: "/home/user/project",
      sessionId: "test",
      flags: defaultFlags,
    }))!;
    await manager.stop();
    expect(docker.stopCalls).toContain(manager.name);
  });
});

describe("SandboxManager.exec", () => {
  it("delegates to DockerClient.exec", async () => {
    const docker = new SpyDockerClient();
    docker.nextRun(ok()); docker.nextRun(ok()); docker.nextRun(ok());
    const manager = (await SandboxManager.start({
      docker, skillResolver: new FakeSkillResolver(),
      hostCwd: "/home/user/project", sessionId: "test", flags: defaultFlags,
    }))!;
    // Override exec for this test
    let execCalled = false;
    const origExec = docker.exec.bind(docker);
    docker.exec = async (c: string, cmd: string) => {
      execCalled = true;
      expect(c).toBe(manager.name);
      return "result";
    };
    const result = await manager.exec("cat /tmp/file");
    expect(execCalled).toBe(true);
    expect(result).toBe("result");
    docker.exec = origExec;
  });
});

describe("SandboxManager.toRemote", () => {
  it("delegates to path-translation module", async () => {
    const { manager } = await startManager({
      flags: { mountCwd: true },
      hostCwd: "/home/user/project",
    });
    expect(manager.toRemote("src/file.ts")).toBe("/workspace/src/file.ts");
  });

  it("respects skill sources", async () => {
    const { manager } = await startManager({
      flags: { mountSkills: true },
      skillDirs: ["/home/user/.agents/skills/my-skill"],
    });
    expect(manager.toRemote("/home/user/.agents/skills/my-skill/README.md"))
      .toBe("/home/node/.agent/skills/my-skill/README.md");
  });
});

describe("SandboxManager.getPromptContext", () => {
  it("returns context with all flags", async () => {
    const { manager } = await startManager({
      flags: { network: true, mountCwd: true, mountSsh: true },
      hostCwd: "/home/user/project",
    });
    const ctx = manager.getPromptContext();
    expect(ctx.name).toBe(manager.name);
    expect(ctx.hasCwd).toBe(true);
    expect(ctx.hasNetwork).toBe(true);
    expect(ctx.hasHostNetwork).toBe(false);
    expect(ctx.hasSkills).toBe(false);
    expect(ctx.hasSsh).toBe(true);
    expect(ctx.hostCwd).toBe("/home/user/project");
  });

  it("reports hasHostNetwork true when hostNetwork flag is set", async () => {
    const { manager } = await startManager({
      flags: { hostNetwork: true },
      hostCwd: "/home/user/project",
    });
    const ctx = manager.getPromptContext();
    expect(ctx.hasHostNetwork).toBe(true);
    expect(ctx.hasNetwork).toBe(true);
  });
});

describe("SandboxManager.injectIntoPrompt", () => {
  it("replaces the CWD line in the system prompt", async () => {
    const { manager } = await startManager({
      flags: { mountCwd: true },
      hostCwd: "/home/user/project",
    });
    const original = "Current working directory: /home/user/project\nSome other content";
    const injected = manager.injectIntoPrompt(original);
    expect(injected).toContain("sandboxed Docker container");
    expect(injected).not.toContain("Current working directory: /home/user/project");
    expect(injected).toContain("Some other content");
  });
});

describe("SandboxManager.start error handling", () => {
  it("returns null when Docker is unavailable", async () => {
    const docker = new SpyDockerClient();
    docker.nextRun(fail("docker not found"));
    const manager = await SandboxManager.start({
      docker, skillResolver: new FakeSkillResolver(),
      hostCwd: "/home/user/project", sessionId: "test", flags: defaultFlags,
    });
    expect(manager).toBeNull();
  });

  it("returns null when image is missing and pull fails", async () => {
    const docker = new SpyDockerClient();
    docker.nextRun(ok()); // version succeeds
    docker.nextRun(fail("not found")); // image inspect fails
    docker.nextRun(fail("pull failed")); // pull fails
    const manager = await SandboxManager.start({
      docker, skillResolver: new FakeSkillResolver(),
      hostCwd: "/home/user/project", sessionId: "test", flags: defaultFlags,
    });
    expect(manager).toBeNull();
  });
});