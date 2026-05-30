import { createRealDockerClient, createRealProcessRunner } from "./docker";
import type { SandboxManager } from "./sandbox";
import type { ToggleStore } from "./toggles";
import type { UIContext } from "./types";

/**
 * Shared toggle helper — confirms, sets, kills container, reloads.
 */
async function toggleFeature(
  feature: string,
  enable: boolean,
  manager: SandboxManager | null,
  toggles: ToggleStore,
  ui: UIContext,
  confirmation: string,
): Promise<void> {
  if (!(await ui.confirm(
    enable ? `Enable ${feature}?` : `Disable ${feature}?`,
    confirmation,
  ))) return;

  toggles.set(feature, enable);
  ui.notify(`${feature} ${enable ? "enabled" : "disabled"}. Restarting sandbox…`, "info");
  if (manager) await manager.stop();
  await ui.reload();
}

/**
 * Route /sandbox subcommands to the appropriate handler.
 */
export async function handleSandboxCommand(
  args: string,
  ui: UIContext,
  getManager: () => SandboxManager | null,
  getToggles: () => ToggleStore,
  getExtensionDir: () => string,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase() || "status";
  const action = parts[1]?.toLowerCase();

  switch (sub) {
    case "status": {
      const m = getManager();
      if (!m) {
        ui.notify("Sandbox is not active.", "info");
        return;
      }
      try {
        const info = await m.exec("id && uname -a && df -h / 2>/dev/null | tail -1");
        const parts: string[] = [];
        if (m.hasNetwork) parts.push("network");
        if (m.hasCwd) parts.push("cwd");
        if (m.hasSkills) parts.push("skills");
        if (m.hasSsh) parts.push("ssh-agent");
        const flagStr = parts.length ? parts.join(", ") : "fully isolated";

        const toggles = getToggles().getAll();
        const toggleStr = Object.keys(toggles).length
          ? " | toggles: " + Object.entries(toggles).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(" ")
          : "";

        ui.notify([
          `🛡 Sandbox: ${m.name}`,
          `Flags: ${flagStr}${toggleStr}`,
          `Resources: memory=${m.memory}, cpus=${m.cpus}`,
          `Host CWD: ${m.hostCwd}`,
          "",
          info,
        ].join("\n"), "info");
      } catch (e: any) {
        ui.notify(`Sandbox error: ${e.message}`, "error");
      }
      break;
    }
    case "doctor": {
      const m = getManager();
      if (!m) { ui.notify("Sandbox is not active.", "info"); return; }
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
        ui.notify(`Sandbox doctor:\n${out}`, "info");
      } catch (e: any) {
        ui.notify(`Doctor failed: ${e.message}`, "error");
      }
      break;
    }
    case "network": {
      if (action === "on" || action === "off") {
        await toggleFeature("network", action === "on", getManager(), getToggles(), ui,
          "This will allow the sandbox to make outbound connections. The browser tool will become available.");
      } else {
        ui.notify("Usage: /sandbox network on|off", "info");
      }
      break;
    }
    case "ssh": {
      if (action === "on" || action === "off") {
        if (action === "on" && !process.env.SSH_AUTH_SOCK) {
          ui.notify("SSH_AUTH_SOCK is not set. SSH agent forwarding won't work.", "warning");
        }
        await toggleFeature("ssh", action === "on", getManager(), getToggles(), ui,
          action === "on"
            ? "Forward the host SSH agent into the sandbox. Git over SSH will use your keys."
            : "Remove SSH agent access. Git over SSH will stop working.");
      } else {
        ui.notify("Usage: /sandbox ssh on|off", "info");
      }
      break;
    }
    case "cwd": {
      if (action === "on" || action === "off") {
        await toggleFeature("cwd", action === "on", getManager(), getToggles(), ui,
          action === "on"
            ? `Mount ${process.cwd()} at /workspace (read-write).`
            : "Unmount the project directory. /workspace will become ephemeral.");
      } else {
        ui.notify("Usage: /sandbox cwd on|off", "info");
      }
      break;
    }
    case "skills": {
      if (action === "on" || action === "off") {
        getToggles().set("skills", action === "on");
        ui.notify(`Skills mount ${action === "on" ? "enabled" : "disabled"}. Restarting sandbox…`, "info");
        const m = getManager();
        if (m) await m.stop();
        await ui.reload();
      } else {
        ui.notify("Usage: /sandbox skills on|off", "info");
      }
      break;
    }
    case "stop":
    case "kill":
    case "restart": {
      const m = getManager();
      const name = m?.name;
      if (m) await m.stop();
      if (sub === "restart" || !name) {
        ui.notify(name ? `Sandbox ${name} killed. Reconnecting…` : "Starting new sandbox…", "info");
        await ui.reload();
      } else {
        ui.notify(`Sandbox ${name} stopped.`, "info");
      }
      break;
    }
    case "rebuild": {
      ui.notify("Rebuilding sandbox image…");
      try {
        const docker = createRealDockerClient(createRealProcessRunner());
        const { ok, stdout, stderr } = await docker.build(getExtensionDir(), "agent-sandbox:latest");
        if (ok) {
          ui.notify(`Sandbox image rebuilt.\n${stdout.slice(-500)}`, "info");
        } else {
          ui.notify(`Rebuild failed:\n${stderr.slice(-1000) || stdout.slice(-1000)}`, "error");
        }
      } catch (e: any) {
        ui.notify(`Rebuild error: ${e.message}`, "error");
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
          ui.notify("No sandbox containers found.", "info");
          break;
        }
        let removed = 0;
        for (const name of names) {
          if (name === m?.name) continue;
          await docker.rm(name);
          removed++;
        }
        ui.notify(`Pruned ${removed} stopped sandbox container${removed !== 1 ? "s" : ""}.`, "info");
      } catch (e: any) {
        ui.notify(`Prune error: ${e.message}`, "error");
      }
      break;
    }
    default:
      ui.notify(`Unknown subcommand: ${sub}\nTry: status, doctor, stop, restart, rebuild, prune, network, ssh, cwd, skills`, "info");
  }
}
