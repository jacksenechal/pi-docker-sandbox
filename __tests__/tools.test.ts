import { describe, it, expect, beforeEach, vi } from "vitest";
import { createReadOps, createWriteOps, createBashOps } from "../tools";
import { q } from "../docker";

// ── Fake SandboxManager ───────────────────────────────────────────────────

class FakeSandboxManager {
  public execCalls: Array<{ cmd: string; timeoutMs?: number }> = [];
  private execResults: Array<{ value: string } | { error: Error }> = [];

  toRemote(p: string): string { return `/workspace/${p}`; }

  get name(): string { return "fake-container"; }

  nextExec(value: string) { this.execResults.push({ value }); }
  nextExecError(msg: string) { this.execResults.push({ error: new Error(msg) }); }

  async exec(cmd: string, timeoutMs?: number): Promise<string> {
    this.execCalls.push({ cmd, timeoutMs });
    const r = this.execResults.shift();
    if (!r) throw new Error("no exec result queued");
    if ("error" in r) throw r.error;
    return r.value;
  }
}

let manager: FakeSandboxManager;

beforeEach(() => {
  manager = new FakeSandboxManager();
});

// ── readOps ───────────────────────────────────────────────────────────────

describe("createReadOps", () => {
  it("readFile calls exec with cat and returns Buffer", async () => {
    manager.nextExec("file contents");
    const ops = createReadOps(manager as any);
    const result = await ops.readFile("test.txt");
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("file contents");
    expect(manager.execCalls[0].cmd).toBe(`cat ${q("/workspace/test.txt")}`);
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

    const ops = createBashOps(manager as any, fakeSpawn);
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
    const ops = createBashOps(manager as any, fakeSpawn);
    await ops.exec("pwd", "src", { onData: vi.fn() });
  });
});