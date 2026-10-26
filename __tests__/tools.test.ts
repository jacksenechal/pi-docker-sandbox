import { describe, it, expect, beforeEach, vi } from "vitest";
import { createReadOps, createWriteOps, createEditOps, createBashOps } from "../tools";
import { q } from "../docker";
import type { SandboxHandle } from "../types";

// ── Fake SandboxHandle ────────────────────────────────────────────────────

class FakeSandboxManager implements SandboxHandle {
  name = "fake-container";
  hostCwd = "/fake/cwd";
  hasCwd = true;
  hasNetwork = false;
  hasHostNetwork = false;
  hasSkills = false;
  hasSsh = false;
  hasDocs = false;
  memory = "4g";
  cpus = "2";
  stopped = false;
  public execCalls: Array<{ cmd: string; timeoutMs?: number }> = [];
  private execResults: Array<{ value: string } | { error: Error }> = [];

  toRemote(p: string): string { return `/workspace/${p}`; }

  nextExec(value: string) { this.execResults.push({ value }); }
  nextExecError(msg: string) { this.execResults.push({ error: new Error(msg) }); }

  async exec(cmd: string, timeoutMs?: number): Promise<string> {
    this.execCalls.push({ cmd, timeoutMs });
    const r = this.execResults.shift();
    if (!r) throw new Error("no exec result queued");
    if ("error" in r) throw r.error;
    return r.value;
  }

  async stop(): Promise<void> { this.stopped = true; }
}

let manager: FakeSandboxManager;

beforeEach(() => {
  manager = new FakeSandboxManager();
});

// ── readOps ───────────────────────────────────────────────────────────────

describe("createReadOps", () => {
  it("readFile reads via base64 and returns the decoded Buffer", async () => {
    manager.nextExec(Buffer.from("file contents").toString("base64"));
    const ops = createReadOps(manager as any);
    const result = await ops.readFile("test.txt");
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("file contents");
    expect(manager.execCalls[0].cmd).toBe(`base64 ${q("/workspace/test.txt")}`);
  });

  it("readFile preserves trailing newlines and whitespace", async () => {
    const content = "  indented\nlast line\n\n";
    // exec() trims stdout; GNU base64 also wraps lines. Neither may alter the bytes.
    const wrapped = Buffer.from(content).toString("base64").replace(/(.{8})/g, "$1\n");
    manager.nextExec(wrapped.trim());
    const ops = createReadOps(manager as any);
    const result = await ops.readFile("test.txt");
    expect(result.toString()).toBe(content);
  });

  it("readFile preserves binary bytes", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x0a]);
    manager.nextExec(bytes.toString("base64"));
    const ops = createReadOps(manager as any);
    const result = await ops.readFile("image.png");
    expect(result.equals(bytes)).toBe(true);
  });

  it("access calls exec with test -r", async () => {
    manager.nextExec("");
    const ops = createReadOps(manager as any);
    await ops.access("data.json");
    expect(manager.execCalls[0].cmd).toBe(`test -r ${q("/workspace/data.json")}`);
  });

  it("detectImageMimeType returns mime type for known image types", async () => {
    manager.nextExec("image/png");
    const ops = createReadOps(manager as any);
    const result = await ops.detectImageMimeType("photo.png");
    expect(result).toBe("image/png");
  });

  it("detectImageMimeType returns null for non-image types", async () => {
    manager.nextExec("text/plain");
    const ops = createReadOps(manager as any);
    const result = await ops.detectImageMimeType("doc.txt");
    expect(result).toBeNull();
  });

  it("detectImageMimeType returns null on exec failure", async () => {
    manager.nextExecError("command failed");
    const ops = createReadOps(manager as any);
    const result = await ops.detectImageMimeType("broken");
    expect(result).toBeNull();
  });
});

// ── writeOps ──────────────────────────────────────────────────────────────

describe("createWriteOps", () => {
  it("writeFile base64-encodes string content and pipes to file", async () => {
    manager.nextExec("");
    const ops = createWriteOps(manager as any);
    await ops.writeFile("out.txt", "hello world");
    const cmd = manager.execCalls[0].cmd;
    expect(cmd).toContain("base64 -d");
    expect(cmd).toContain(q("/workspace/out.txt"));
    // Verify it contains the base64 of "hello world"
    const b64 = Buffer.from("hello world").toString("base64");
    expect(cmd).toContain(b64);
  });

  it("writeFile handles Uint8Array content", async () => {
    manager.nextExec("");
    const ops = createWriteOps(manager as any);
    const data = new Uint8Array([0x00, 0xFF, 0x42]);
    await ops.writeFile("bin.dat", data);
    const b64 = Buffer.from(data).toString("base64");
    expect(manager.execCalls[0].cmd).toContain(b64);
  });

  it("mkdir creates directory recursively", async () => {
    manager.nextExec("");
    const ops = createWriteOps(manager as any);
    await ops.mkdir("a/b/c");
    expect(manager.execCalls[0].cmd).toBe(`mkdir -p ${q("/workspace/a/b/c")}`);
  });
});

// ── bashOps ───────────────────────────────────────────────────────────────

describe("createBashOps", () => {
  it("spawns docker exec with the correct command", async () => {
    // Use a fake spawn that immediately emits close
    const fakeSpawn = (bin: string, args: string[], opts: any) => {
      expect(bin).toBe("docker");
      expect(args[0]).toBe("exec");
      expect(args[1]).toBe("fake-container");
      expect(args[2]).toBe("sh");
      expect(args[3]).toBe("-c");
      expect(args[4]).toContain("cd");
      expect(args[4]).toContain("/workspace/dir");
      expect(args[4]).toContain("ls -la");
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: Function) => {
          if (event === "close") setTimeout(() => cb(0), 0);
          if (event === "error") {}
          return {} as any;
        },
        kill: () => {},
      } as any;
    };

    const ops = createBashOps(manager as any, fakeSpawn as any);
    const onData = vi.fn();
    const result = await ops.exec("ls -la", "dir", { onData, timeout: 10 });
    expect(result.exitCode).toBe(0);
  });

  it("uses the correct remote CWD", async () => {
    const fakeSpawn = (bin: string, args: string[], opts: any) => {
      expect(args[4]).toContain(q("/workspace/src"));
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: Function) => {
          if (event === "close") cb(0);
          return {} as any;
        },
        kill: () => {},
      } as any;
    };
    const ops = createBashOps(manager as any, fakeSpawn as any);
    await ops.exec("pwd", "src", { onData: vi.fn() });
  });
});

// ── editOps ───────────────────────────────────────────────────────────────

describe("createEditOps", () => {
  it("read then write round-trips a file ending in a newline unchanged", async () => {
    const content = "export const x = 1;\n";
    manager.nextExec(Buffer.from(content).toString("base64"));
    manager.nextExec("");
    const ops = createEditOps(manager as any);
    const read = await ops.readFile("x.ts");
    await ops.writeFile("x.ts", read);
    const written = manager.execCalls[1].cmd.match(/^printf %s '([^']*)'/)![1];
    expect(Buffer.from(written, "base64").toString()).toBe(content);
  });
});
