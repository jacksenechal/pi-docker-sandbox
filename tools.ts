import { spawn } from "node:child_process";
import { q } from "./docker";
import type { SandboxHandle } from "./types";

// ── Read ops ──────────────────────────────────────────────────────────────

export interface ReadOps {
  readFile(path: string): Promise<Buffer>;
  access(path: string): Promise<void>;
  detectImageMimeType(path: string): Promise<string | null>;
}

export function createReadOps(manager: SandboxHandle): ReadOps {
  return {
    readFile: async (p) => {
      const remote = manager.toRemote(p);
      const data = await manager.exec(`cat ${q(remote)}`);
      return Buffer.from(data);
    },
    access: async (p) => {
      const remote = manager.toRemote(p);
      await manager.exec(`test -r ${q(remote)}`);
    },
    detectImageMimeType: async (p) => {
      try {
        const remote = manager.toRemote(p);
        const m = await manager.exec(`file --mime-type -b ${q(remote)}`);
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

// ── Write ops ─────────────────────────────────────────────────────────────

export interface WriteOps {
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

export function createWriteOps(manager: SandboxHandle): WriteOps {
  return {
    writeFile: async (p, content) => {
      const remote = manager.toRemote(p);
      const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
      const b64 = buf.toString("base64");
      await manager.exec(`printf %s ${q(b64)} | base64 -d > ${q(remote)}`);
    },
    mkdir: async (dir) => {
      const remote = manager.toRemote(dir);
      await manager.exec(`mkdir -p ${q(remote)}`);
    },
  };
}

// ── Edit ops (composition of read + write) ────────────────────────────────

export interface EditOps {
  readFile(path: string): Promise<Buffer>;
  access(path: string): Promise<void>;
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
}

export function createEditOps(manager: SandboxHandle): EditOps {
  const ro = createReadOps(manager);
  const wo = createWriteOps(manager);
  return {
    readFile: ro.readFile,
    access: ro.access,
    writeFile: wo.writeFile,
  };
}

// ── Bash ops (streaming) ──────────────────────────────────────────────────

export interface BashOps {
  exec(
    command: string,
    directory: string,
    opts: {
      onData: (b: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    },
  ): Promise<{ exitCode: number | null }>;
}

export function createBashOps(
  manager: SandboxHandle,
  spawnImpl: typeof spawn = spawn,
): BashOps {
  return {
    exec(command, directory, opts) {
      const remoteCwd = manager.toRemote(directory);
      return new Promise((resolve, reject) => {
        const child = spawnImpl("docker", [
          "exec", manager.name, "sh", "-c",
          `cd ${q(remoteCwd)} && ${command}`,
        ], { stdio: ["ignore", "pipe", "pipe"] });

        let timedOut = false;
        const timer = opts.timeout
          ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeout * 1000)
          : undefined;

        child.stdout.on("data", opts.onData);
        child.stderr.on("data", opts.onData);

        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        });

        const onAbort = () => child.kill("SIGKILL");
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          if (opts.signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}