import { resolve as resolvePath } from "node:path";
import type { PathContext } from "./types";

const REMOTE_WORKSPACE = "/workspace";
const REMOTE_SKILLS = "/home/node/.agent/skills";

/**
 * Translate a host path to its container-side equivalent.
 *
 *   - /workspace/… passes through (container-absolute path)
 *   - /home/node/.agent/skills/… passes through
 *   - When CWD is mounted: paths inside hostCwd → /workspace/…
 *   - When CWD is NOT mounted: relative paths → /workspace/… (internal)
 *   - Absolute paths (when CWD is not mounted) → rejected
 *   - Paths inside a skill dir → /home/node/.agent/skills/…
 */
export function toRemote(hostPath: string, c: PathContext): string {
  // Already a container absolute path.
  if (hostPath === REMOTE_WORKSPACE || hostPath.startsWith(`${REMOTE_WORKSPACE}/`)) {
    return hostPath;
  }
  if (hostPath === REMOTE_SKILLS || hostPath.startsWith(`${REMOTE_SKILLS}/`)) {
    return hostPath;
  }

  // Check if path belongs to a mounted skill directory.
  // Each skill source dir is bind-mounted at /home/node/.agent/skills/<name>,
  // so preserve the directory basename in the translated path.
  if (c.hasSkills) {
    const abs = resolvePath(c.hostCwd, hostPath);
    for (const src of c.skillSources) {
      if (abs === src || abs.startsWith(`${src}/`)) {
        const name = src.split("/").filter(Boolean).pop()!;
        if (abs === src) return `${REMOTE_SKILLS}/${name}`;
        const rel = abs.slice(src.length + 1);
        return `${REMOTE_SKILLS}/${name}/${rel}`;
      }
    }
  }

  // Resolve the absolute host path, then map it into the container.
  // Host CWD always maps to /workspace/… whether or not it's actually
  // bind-mounted (if not mounted, the container's internal /workspace
  // provides ephemeral storage).
  const abs = resolvePath(c.hostCwd, hostPath);
  if (abs !== c.hostCwd && !abs.startsWith(`${c.hostCwd}/`)) {
    throw new Error(`sandbox: path outside project cwd: ${abs}`);
  }
  const rel = abs === c.hostCwd ? "" : abs.slice(c.hostCwd.length + 1);
  return rel ? `${REMOTE_WORKSPACE}/${rel}` : REMOTE_WORKSPACE;
}