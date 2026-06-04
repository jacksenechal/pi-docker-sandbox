import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompt";

describe("buildSystemPrompt", () => {
  const cwd = "/home/user/project";
  const name = "pi-agent-abc123";

  it("shows CWD mount info when hasCwd is true", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: true,
      hasNetwork: false,
      hasHostNetwork: false,
      hasSkills: false,
      hasSsh: false,
      hostCwd: cwd,
    });
    expect(prompt).toContain("Current working directory: /workspace");
    expect(prompt).toContain("mounted read-write");
    expect(prompt).toContain("Changes to /workspace persist on the host");
  });

  it("shows ephemeral warning when hasCwd is false", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: false,
      hasHostNetwork: false,
      hasSkills: false,
      hasSsh: false,
      hostCwd: cwd,
    });
    expect(prompt).toContain("NOT mounted");
    expect(prompt).toContain("ephemeral");
    expect(prompt).toContain("--sandbox-mount-cwd");
  });

  it("shows skills mount info when hasSkills is true", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: false,
      hasHostNetwork: false,
      hasSkills: true,
      hasSsh: false,
      hostCwd: cwd,
    });
    expect(prompt).toContain("Agent skills are mounted read-only");
    expect(prompt).toContain("/home/node/.agent/skills/");
  });

  it("shows network enabled with host.docker.internal hint in bridge mode", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: true,
      hasHostNetwork: false,
      hasSkills: false,
      hasSsh: false,
      hostCwd: cwd,
    });
    expect(prompt).toContain("Network is enabled");
    expect(prompt).toContain('"browser" tool is available');
    expect(prompt).toContain("host.docker.internal");
  });

  it("shows host-network enabled with localhost hint", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: true,
      hasHostNetwork: true,
      hasSkills: false,
      hasSsh: false,
      hostCwd: cwd,
    });
    expect(prompt).toContain("Network is enabled (host networking)");
    expect(prompt).toContain('"browser" tool is available');
    expect(prompt).toContain("localhost:");
    expect(prompt).not.toContain("host.docker.internal");
  });

  it("shows network disabled warning", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: false,
      hasHostNetwork: false,
      hasSkills: false,
      hasSsh: false,
      hostCwd: cwd,
    });
    expect(prompt).toContain("Network is DISABLED");
    expect(prompt).toContain("external network access is blocked");
  });

  it("shows SSH agent forwarded message", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: false,
      hasHostNetwork: false,
      hasSkills: false,
      hasSsh: true,
      hostCwd: cwd,
    });
    expect(prompt).toContain("SSH agent is forwarded");
  });

  it("combines all active features in one prompt", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: true,
      hasNetwork: true,
      hasHostNetwork: false,
      hasSkills: true,
      hasSsh: true,
      hasDocs: false,
      hostCwd: cwd,
    });
    expect(prompt).toContain("mounted read-write");
    expect(prompt).toContain("Network is enabled");
    expect(prompt).toContain("skills are mounted");
    expect(prompt).toContain("SSH agent is forwarded");
  });

  it("shows docs mount info when hasDocs is true", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: false,
      hasHostNetwork: false,
      hasSkills: false,
      hasSsh: false,
      hasDocs: true,
      hostCwd: cwd,
    });
    expect(prompt).toContain("Pi documentation is mounted read-only");
    expect(prompt).toContain("/home/node/.agent/docs/");
  });

  it("includes docs alongside skills when both are mounted", () => {
    const prompt = buildSystemPrompt({
      name,
      hasCwd: false,
      hasNetwork: false,
      hasHostNetwork: false,
      hasSkills: true,
      hasSsh: false,
      hasDocs: true,
      hostCwd: cwd,
    });
    expect(prompt).toContain("skills are mounted");
    expect(prompt).toContain("documentation is mounted");
  });
});
