import { spawn, spawnSync } from "node:child_process";
import type { DockerClient, DockerResult, ProcessResult, ProcessRunner } from "./types";

// ── Constants ────────────────────────────────────────────────────────────

const DOCKER = "docker";

// ── Shell quoting ────────────────────────────────────────────────────────

/** POSIX-safe single-quote shell escaping. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Process runner (real implementation) ─────────────────────────────────

function spawnOut(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: "spawn error", timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        timedOut,
      });
    });
  });
}

export function createRealProcessRunner(): ProcessRunner {
  return { run: spawnOut };
}

// ── Docker client (real implementation) ──────────────────────────────────

export function createRealDockerClient(runner: ProcessRunner): DockerClient {
  async function dockerRun(args: string[], timeoutMs = 30000): Promise<DockerResult> {
    const r = await runner.run(DOCKER, args, timeoutMs);
    return { ok: r.code === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr };
  }

  async function dockerExec(
    container: string,
    cmd: string,
    timeoutMs = 30000,
  ): Promise<string> {
    const r = await runner.run(DOCKER, ["exec", container, "sh", "-c", cmd], timeoutMs);
    if (r.code !== 0 || r.timedOut) {
      const detail = r.stderr.trim() || r.stdout.trim() || `code=${r.code}`;
      throw new Error(`exec failed: ${detail}`);
    }
    return r.stdout.trim();
  }

  return {
    run: dockerRun,

    exec: dockerExec,

    async stop(container: string): Promise<void> {
      await dockerRun(["kill", container], 3000);
    },

    async rm(container: string): Promise<void> {
      await dockerRun(["rm", "-f", container], 5000);
    },

    async version(): Promise<boolean> {
      const { ok } = await dockerRun(["version"], 5000);
      return ok;
    },

    async imageExists(image: string): Promise<boolean> {
      const { ok } = await dockerRun(["image", "inspect", image], 10000);
      return ok;
    },

    async pull(image: string): Promise<boolean> {
      const { ok } = await dockerRun(["pull", image], 120000);
      return ok;
    },

    async build(dir: string, image: string): Promise<DockerResult> {
      return dockerRun(["build", "-t", image, dir], 120000);
    },
  };
}

/** Synchronously stop a container. For signal/exit handlers only. */
export function stopSync(name: string): void {
  spawnSync(DOCKER, ["rm", "-f", name], { stdio: "ignore", timeout: 5000 });
}
