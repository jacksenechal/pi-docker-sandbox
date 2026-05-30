import { resolve as resolvePath } from "node:path";
import type { PathContext } from "./types";

const REMOTE_WORKSPACE = "/workspace";
const REMOTE_SKILLS = "/home/node/.agent/skills";
const REMOTE_DOCS = "/home/node/.agent/docs";

/**
 * Translate a host path to its container-side equivalent.
 *
 *   - /workspace/… passes through (container-absolute path)
 *   - /home/node/.agent/skills/… passes through
 *   - /home/node/.agent/docs/… passes through
 *   - Paths inside pi docs dir → /home/node/.agent/docs/…
 *   - Paths inside a skill dir → /home/node/.agent/skills/…
 *   - When CWD is mounted: paths inside hostCwd → /workspace/…
 *   - When CWD is NOT mounted: relative paths → /workspace/… (internal)
 *   - Absolute paths (when CWD is not mounted) → rejected
 */
export function toRemote(hostPath: string, c: PathContext): string {
  // Already a container absolute path.
  if (hostPath === REMOTE_WORKSPACE || hostPath.startsWith(`${REMOTE_WORKSPACE}/`)) {
    return hostPath;
  }
  if (hostPath === REMOTE_SKILLS || hostPath.startsWith(`${REMOTE_SKILLS}/`)) {
    return hostPath;
  }
  if (hostPath === REMOTE_DOCS || hostPath.startsWith(`${REMOTE_DOCS}/`)) {
    return hostPath;
  }

  // Resolve once — shared by docs, skills, and hostCwd checks.
  const abs = resolvePath(c.hostCwd, hostPath);

  // Check if path belongs to the pi docs directory.
  if (c.docsPath) {
    if (abs === c.docsPath || abs.startsWith(`${c.docsPath}/`)) {
      if (abs === c.docsPath) return REMOTE_DOCS;
      const rel = abs.slice(c.docsPath.length + 1);
      return `${REMOTE_DOCS}/${rel}`;
    }
  }

  // Check if path belongs to a mounted skill directory.
  // Each skill source dir is bind-mounted at /home/node/.agent/skills/<name>,
  // so preserve the directory basename in the translated path.
  if (c.hasSkills) {
    for (const src of c.skillSources) {
      if (abs === src || abs.startsWith(`${src}/`)) {
        const name = src.split("/").filter(Boolean).pop()!;
        if (abs === src) return `${REMOTE_SKILLS}/${name}`;
        const rel = abs.slice(src.length + 1);
        return `${REMOTE_SKILLS}/${name}/${rel}`;
      }
    }
  }

  // Map host CWD into the container.
  // Note: /workspace is always writable (bind-mounted if hasCwd, ephemeral otherwise).
  if (abs !== c.hostCwd && !abs.startsWith(`${c.hostCwd}/`)) {
    throw new Error(`sandbox: path outside project cwd: ${abs}`);
  }
  const rel = abs === c.hostCwd ? "" : abs.slice(c.hostCwd.length + 1);
  return rel ? `${REMOTE_WORKSPACE}/${rel}` : REMOTE_WORKSPACE;
}