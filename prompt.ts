export interface PromptContext {
  name: string;
  hasCwd: boolean;
  hasNetwork: boolean;
  hasSkills: boolean;
  hasSsh: boolean;
  hasDocs?: boolean;
  hostCwd: string;
}

const REMOTE_WORKSPACE = "/workspace";
const REMOTE_SKILLS = "/home/node/.agent/skills";

/**
 * Build the sandbox status lines injected into the agent system prompt.
 *
 * Replaces the standard "Current working directory: …" line in the
 * agent prompt with sandbox-aware information.
 */
export function buildSystemPrompt(c: PromptContext): string {
  const parts = [
    `Current working directory: ${c.hasCwd ? REMOTE_WORKSPACE : "/"} (sandboxed Docker container ${c.name})`,
  ];

  if (c.hasCwd) {
    parts.push(
      `Host project ${c.hostCwd} is mounted read-write at ${REMOTE_WORKSPACE}. Changes to ${REMOTE_WORKSPACE} persist on the host.`,
    );
  } else {
    parts.push(
      `The host project is NOT mounted. ${REMOTE_WORKSPACE} is an ephemeral directory inside the container — all file writes are lost when the session ends. Use --sandbox-mount-cwd to persist work to the host project.`,
    );
  }

  if (c.hasSkills) {
    parts.push(
      `Agent skills are mounted read-only at ${REMOTE_SKILLS}/. Read skill files directly (e.g. ${REMOTE_SKILLS}/<name>/SKILL.md).`,
    );
  }

  if (c.hasDocs) {
    parts.push(
      `Pi documentation is mounted read-only at /home/node/.agent/docs/. Read docs with the read tool (e.g., /home/node/.agent/docs/extensions.md).`,
    );
  }

  if (c.hasNetwork) {
    parts.push(`Network is enabled. The "browser" tool is available.`);
  } else {
    parts.push(`Network is DISABLED. All external network access is blocked.`);
  }

  if (c.hasSsh) {
    parts.push(`SSH agent is forwarded. Git operations over SSH will use the host's SSH agent.`);
  }

  return parts.join("\n");
}