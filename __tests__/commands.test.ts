import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleSandboxCommand } from "../commands";
import type { SandboxHandle, UIContext } from "../types";

// ── Spy UIContext ─────────────────────────────────────────────────────────

class SpyUIContext implements UIContext {
  public notifications: Array<{ message: string; severity: string }> = [];
  public confirms: Array<{ title: string; body: string }> = [];
  public confirmAnswers: boolean[] = [];
  public reloadCalls = 0;
  public statusLines: Array<{ key: string; text: string }> = [];

  notify(message: string, severity?: "info" | "warning" | "error"): void {
    this.notifications.push({ message, severity: severity ?? "info" });
  }
  async confirm(title: string, body: string): Promise<boolean> {
    this.confirms.push({ title, body });
    return this.confirmAnswers.shift() ?? false;
  }
  async reload(): Promise<void> { this.reloadCalls++; }
  setStatus(key: string, text: string): void { this.statusLines.push({ key, text }); }
}

// ── Fake manager ──────────────────────────────────────────────────────────

class FakeManager implements SandboxHandle {
  name = "pi-agent-test";
  hostCwd = "/home/user/project";
  hasNetwork = false;
  hasCwd = false;
  hasSkills = false;
  hasSsh = false;
  hasDocs = false;
  memory = "4g";
  cpus = "2";
  stopped = false;

  async exec(_cmd: string, _timeoutMs?: number): Promise<string> {
    return "node\nLinux\n/dev/sda1  10G  2G  8G  20% /";
  }
  toRemote(hostPath: string): string { return `/workspace/${hostPath}`; }
  async stop(): Promise<void> { this.stopped = true; }
}

// ── Fake toggle store ─────────────────────────────────────────────────────

class FakeToggleStore {
  private state: Record<string, boolean> = {};
  get(key: string): boolean | undefined { return this.state[key]; }
  set(key: string, value: boolean): void { this.state[key] = value; }
  getAll(): Record<string, boolean> { return { ...this.state }; }
}

// ── Test helper ───────────────────────────────────────────────────────────

async function runCommand(
  args: string,
  opts: {
    manager?: SandboxHandle | null;
    toggles?: FakeToggleStore;
    ui?: SpyUIContext;
  } = {},
) {
  const ui = opts.ui ?? new SpyUIContext();
  await handleSandboxCommand(
    args,
    ui,
    () => opts.manager ?? null,
    () => (opts.toggles ?? new FakeToggleStore()) as any,
    () => "/fake/extension/dir",
  );
  return { ui };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("handleSandboxCommand", () => {
  describe("status", () => {
    it("shows status when sandbox is active", async () => {
      const manager = new FakeManager();
      manager.hasNetwork = true;
      const { ui } = await runCommand("status", { manager });
      expect(ui.notifications.length).toBe(1);
      expect(ui.notifications[0].message).toContain("pi-agent-test");
      expect(ui.notifications[0].message).toContain("network");
    });

    it("shows not active when sandbox is null", async () => {
      const { ui } = await runCommand("status", { manager: null });
      expect(ui.notifications[0].message).toContain("not active");
    });

    it("defaults to status when no subcommand given", async () => {
      const manager = new FakeManager();
      const { ui } = await runCommand("", { manager });
      expect(ui.notifications[0].message).toContain("pi-agent-test");
    });
  });

  describe("doctor", () => {
    it("runs health check and displays output", async () => {
      const manager = new FakeManager();
      const { ui } = await runCommand("doctor", { manager });
      expect(ui.notifications[0].message).toContain("Sandbox doctor");
    });

    it("shows not active when no sandbox", async () => {
      const { ui } = await runCommand("doctor", { manager: null });
      expect(ui.notifications[0].message).toContain("not active");
    });
  });

  describe("toggle features", () => {
    it("toggles network on when user confirms", async () => {
      const manager = new FakeManager();
      const ui = new SpyUIContext();
      const toggles = new FakeToggleStore();
      ui.confirmAnswers.push(true);
      await runCommand("network on", { manager, toggles, ui });
      expect(toggles.get("network")).toBe(true);
      expect(manager.stopped).toBe(true);
      expect(ui.reloadCalls).toBe(1);
    });

    it("does nothing when user declines", async () => {
      const toggles = new FakeToggleStore();
      const ui = new SpyUIContext();
      ui.confirmAnswers.push(false);
      await runCommand("network on", { manager: new FakeManager(), toggles, ui });
      expect(toggles.get("network")).toBeUndefined();
      expect(ui.reloadCalls).toBe(0);
    });

    it("shows usage hint for missing action", async () => {
      const { ui } = await runCommand("network");
      expect(ui.notifications[0].message).toContain("Usage: /sandbox network on|off");
    });
  });

  describe("stop / restart", () => {
    it("stop kills container and notifies", async () => {
      const manager = new FakeManager();
      const { ui } = await runCommand("stop", { manager });
      expect(manager.stopped).toBe(true);
      expect(ui.notifications[0].message).toContain("stopped");
    });

    it("restart kills container and reloads", async () => {
      const manager = new FakeManager();
      const { ui } = await runCommand("restart", { manager });
      expect(manager.stopped).toBe(true);
      expect(ui.reloadCalls).toBe(1);
    });
  });

  describe("unknown subcommand", () => {
    it("shows help message", async () => {
      const { ui } = await runCommand("unknown");
      expect(ui.notifications[0].message).toContain("Unknown subcommand");
      expect(ui.notifications[0].message).toContain("status, doctor, stop");
    });
  });
});