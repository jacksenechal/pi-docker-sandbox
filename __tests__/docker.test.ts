import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRealDockerClient, q } from "../docker";
import type { DockerClient, ProcessResult, ProcessRunner } from "../types";

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeProcessRunner implements ProcessRunner {
  private responses: ProcessResult[] = [];
  public calls: Array<{ bin: string; args: string[]; timeoutMs: number }> = [];

  /** Queue up a response for the next call. */
  next(result: ProcessResult): void {
    this.responses.push(result);
  }

  async run(bin: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    this.calls.push({ bin, args, timeoutMs });
    return this.responses.shift() ?? { code: -1, stdout: "", stderr: "no queued response", timedOut: false };
  }
}

function ok(stdout = ""): ProcessResult {
  return { code: 0, stdout, stderr: "", timedOut: false };
}

function fail(stderr = "error", code = 1): ProcessResult {
  return { code, stdout: "", stderr, timedOut: false };
}

function timeout(): ProcessResult {
  return { code: null, stdout: "", stderr: "", timedOut: true };
}

// ── Setup ────────────────────────────────────────────────────────────────

let runner: FakeProcessRunner;
let docker: DockerClient;

beforeEach(() => {
  runner = new FakeProcessRunner();
  docker = createRealDockerClient(runner);
});

// ── Tests: shell quoting ─────────────────────────────────────────────────

describe("q (shell quoting)", () => {
  it("wraps a simple string in single quotes", () => {
    expect(q("hello")).toBe("'hello'");
  });

  it("escapes single quotes inside the string", () => {
    expect(q("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(q("")).toBe("''");
  });

  it("handles strings with special characters", () => {
    expect(q('echo "$HOME"')).toBe("'echo \"$HOME\"'");
  });
});

// ── Tests: DockerClient.run ──────────────────────────────────────────────

describe("DockerClient.run", () => {
  it("passes args to docker CLI and returns ok on success", async () => {
    runner.next(ok("1.2.3"));
    const result = await docker.run(["version"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("1.2.3");
    expect(runner.calls[0].args).toEqual(["version"]);
  });

  it("returns ok=false on non-zero exit", async () => {
    runner.next(fail("connection refused"));
    const result = await docker.run(["ps"]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("connection refused");
  });

  it("returns ok=false on timeout", async () => {
    runner.next(timeout());
    const result = await docker.run(["ps"]);
    expect(result.ok).toBe(false);
  });

  it("uses default 30s timeout", async () => {
    runner.next(ok());
    await docker.run(["ps"]);
    expect(runner.calls[0].timeoutMs).toBe(30000);
  });

  it("respects explicit timeout", async () => {
    runner.next(ok());
    await docker.run(["pull", "image"], 60000);
    expect(runner.calls[0].timeoutMs).toBe(60000);
  });
});

// ── Tests: DockerClient.version ──────────────────────────────────────────

describe("DockerClient.version", () => {
  it("returns true when docker daemon is available", async () => {
    runner.next(ok());
    expect(await docker.version()).toBe(true);
    expect(runner.calls[0].args).toEqual(["version"]);
  });

  it("returns false when docker is unavailable", async () => {
    runner.next(fail());
    expect(await docker.version()).toBe(false);
  });
});

// ── Tests: DockerClient.imageExists ──────────────────────────────────────

describe("DockerClient.imageExists", () => {
  it("returns true when image inspect succeeds", async () => {
    runner.next(ok("[{}]"));
    expect(await docker.imageExists("agent-sandbox:latest")).toBe(true);
    expect(runner.calls[0].args).toEqual(["image", "inspect", "agent-sandbox:latest"]);
  });

  it("returns false when image does not exist", async () => {
    runner.next(fail());
    expect(await docker.imageExists("agent-sandbox:latest")).toBe(false);
  });
});

// ── Tests: DockerClient.pull ─────────────────────────────────────────────

describe("DockerClient.pull", () => {
  it("pulls an image and returns true on success", async () => {
    runner.next(ok());
    expect(await docker.pull("agent-sandbox:latest")).toBe(true);
    expect(runner.calls[0].args).toEqual(["pull", "agent-sandbox:latest"]);
  });

  it("returns false on pull failure", async () => {
    runner.next(fail());
    expect(await docker.pull("agent-sandbox:latest")).toBe(false);
  });
});

// ── Tests: DockerClient.exec ─────────────────────────────────────────────

describe("DockerClient.exec", () => {
  it("executes a command and returns trimmed stdout", async () => {
    runner.next(ok("node\n"));
    const result = await docker.exec("my-container", "id -un");
    expect(result).toBe("node");
    expect(runner.calls[0].args).toEqual([
      "exec", "my-container", "sh", "-c", "id -un",
    ]);
  });

  it("throws on non-zero exit", async () => {
    runner.next(fail("command not found", 127));
    await expect(docker.exec("c", "badcmd")).rejects.toThrow(
      "exec failed: command not found",
    );
  });

  it("throws on timeout", async () => {
    runner.next(timeout());
    await expect(docker.exec("c", "cmd")).rejects.toThrow("exec failed");
  });

  it("throws with code detail when stderr is empty", async () => {
    runner.next({ code: 1, stdout: "", stderr: "", timedOut: false });
    await expect(docker.exec("c", "cmd")).rejects.toThrow(
      "exec failed: code=1",
    );
  });
});

// ── Tests: DockerClient.stop ─────────────────────────────────────────────

describe("DockerClient.stop", () => {
  it("kills the container (docker kill)", async () => {
    runner.next(ok());
    await docker.stop("my-container");
    expect(runner.calls[0].args).toEqual(["kill", "my-container"]);
  });
});

// ── Tests: DockerClient.rm ───────────────────────────────────────────────

describe("DockerClient.rm", () => {
  it("force-removes the container (docker rm -f)", async () => {
    runner.next(ok());
    await docker.rm("my-container");
    expect(runner.calls[0].args).toEqual(["rm", "-f", "my-container"]);
  });
});

// ── Tests: DockerClient.build ────────────────────────────────────────────

describe("DockerClient.build", () => {
  it("builds an image and returns ok on success", async () => {
    runner.next(ok("Successfully built"));
    const result = await docker.build("/path/to/dir", "my-image:tag");
    expect(result.ok).toBe(true);
    expect(runner.calls[0].args).toEqual([
      "build", "-t", "my-image:tag", "/path/to/dir",
    ]);
  });

  it("returns ok=false on build failure", async () => {
    runner.next(fail("build failed"));
    const result = await docker.build("/dir", "img");
    expect(result.ok).toBe(false);
  });
});
