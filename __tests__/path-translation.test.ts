import { describe, it, expect } from "vitest";
import { toRemote } from "../path-translation";
import type { PathContext } from "../types";

// ── Test helpers ────────────────────────────────────────────────────────

const WS = "/workspace";
const SK = "/home/node/.agent/skills";

function ctx(overrides: Partial<PathContext> = {}): PathContext {
  return {
    hostCwd: "/home/user/project",
    hasCwd: true,
    hasSkills: false,
    skillSources: [],
    ...overrides,
  };
}

// ── Pass-through: already-remote paths ──────────────────────────────────

describe("toRemote: pass-through (already remote)", () => {
  it("returns /workspace unchanged", () => {
    expect(toRemote("/workspace", ctx())).toBe("/workspace");
  });

  it("returns /workspace/subpath unchanged", () => {
    expect(toRemote("/workspace/src/file.ts", ctx())).toBe("/workspace/src/file.ts");
  });

  it("returns /home/node/.agent/skills unchanged", () => {
    expect(toRemote("/home/node/.agent/skills", ctx())).toBe("/home/node/.agent/skills");
  });

  it("returns /home/node/.agent/skills/sub unchanged", () => {
    const path = "/home/node/.agent/skills/my-skill/SKILL.md";
    expect(toRemote(path, ctx())).toBe(path);
  });

  it("pass-through takes priority over hostCwd mapping", () => {
    // Even if hostCwd happens to be /workspace, explicit /workspace paths pass through
    const c = ctx({ hostCwd: "/workspace" });
    expect(toRemote("/workspace/foo", c)).toBe("/workspace/foo");
  });
});

// ── Skill directory mapping ─────────────────────────────────────────────

describe("toRemote: skill directory mapping", () => {
  const skillDir = "/home/user/.agents/skills/my-skill";

  it("maps a path inside a skill source to /home/node/.agent/skills/...", () => {
    const c = ctx({
      hasSkills: true,
      skillSources: [skillDir],
    });
    expect(toRemote(`${skillDir}/SKILL.md`, c)).toBe(`${SK}/my-skill/SKILL.md`);
  });

  it("maps the skill source directory itself", () => {
    const c = ctx({
      hasSkills: true,
      skillSources: [skillDir],
    });
    expect(toRemote(skillDir, c)).toBe(`${SK}/my-skill`);
  });

  it("maps from the first matching skill source", () => {
    const c = ctx({
      hasSkills: true,
      skillSources: [
        "/home/user/.pi/agent/skills/other",
        skillDir,
        "/home/user/.agents/skills/third",
      ],
    });
    expect(toRemote(`${skillDir}/references/guide.md`, c)).toBe(
      `${SK}/my-skill/references/guide.md`,
    );
  });

  it("skill mapping takes priority over hostCwd when path is in both", () => {
    // Skill source IS inside hostCwd — skill check comes first, so it wins
    const c = ctx({
      hasSkills: true,
      hostCwd: "/home/user",
      skillSources: ["/home/user/.agents/skills/my-skill"],
    });
    expect(toRemote("/home/user/.agents/skills/my-skill/README.md", c)).toBe(
      `${SK}/my-skill/README.md`,
    );
  });
});

// ── Host CWD → /workspace mapping ────────────────────────────────────────

describe("toRemote: host CWD → /workspace mapping", () => {
  it("maps a relative path inside hostCwd", () => {
    expect(toRemote("src/file.ts", ctx())).toBe("/workspace/src/file.ts");
  });

  it("maps an absolute path inside hostCwd", () => {
    expect(toRemote("/home/user/project/lib/util.ts", ctx())).toBe(
      "/workspace/lib/util.ts",
    );
  });

  it("maps hostCwd itself to /workspace", () => {
    expect(toRemote("/home/user/project", ctx())).toBe("/workspace");
  });

  it('maps "." to /workspace', () => {
    expect(toRemote(".", ctx())).toBe("/workspace");
  });

  it("maps when CWD is not mounted (ephemeral /workspace)", () => {
    const c = ctx({ hasCwd: false });
    expect(toRemote("output.log", c)).toBe("/workspace/output.log");
  });

  it("maps deeply nested paths", () => {
    expect(
      toRemote("a/b/c/d/e/f/g.txt", ctx({ hostCwd: "/home/user/project" })),
    ).toBe("/workspace/a/b/c/d/e/f/g.txt");
  });
});

// ── Rejection: paths outside the project ────────────────────────────────

describe("toRemote: rejection of out-of-project paths", () => {
  it("throws for an absolute path outside hostCwd", () => {
    expect(() => toRemote("/etc/passwd", ctx())).toThrow(
      "sandbox: path outside project cwd",
    );
  });

  it("throws for a relative path that resolves outside hostCwd", () => {
    expect(() => toRemote("../../etc/passwd", ctx())).toThrow(
      "sandbox: path outside project cwd",
    );
  });

  it("throws when hasSkills is false and path is in a skill source outside hostCwd", () => {
    const c = ctx({
      hasSkills: false, // skill mapping disabled
      skillSources: ["/home/user/.agents/skills/my-skill"],
    });
    // Without skill mapping, this absolute path falls through to hostCwd check
    expect(() =>
      toRemote("/home/user/.agents/skills/my-skill/SKILL.md", c),
    ).toThrow("sandbox: path outside project cwd");
  });

  it("allows a path inside docsPath even when outside hostCwd", () => {
    const c = ctx({
      docsPath: "/opt/pi/docs",
    });
    const result = toRemote("/opt/pi/docs/extensions.md", c);
    expect(result).toBe("/home/node/.agent/docs/extensions.md");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe("toRemote: edge cases", () => {
  it("works with empty skillSources when hasSkills is true", () => {
    const c = ctx({ hasSkills: true, skillSources: [] });
    expect(toRemote("file.txt", c)).toBe("/workspace/file.txt");
  });

  it("treats adjacent path (not a prefix match) as outside hostCwd", () => {
    // /home/user/project-other is NOT a prefix of /home/user/project
    expect(() =>
      toRemote("/home/user/project-other/file.txt", ctx()),
    ).toThrow("sandbox: path outside project cwd");
  });

  it("maps path that equals a skill source exactly", () => {
    const c = ctx({
      hasSkills: true,
      skillSources: ["/home/user/.agents/skills/my-skill"],
    });
    expect(toRemote("/home/user/.agents/skills/my-skill", c)).toBe(
      `${SK}/my-skill`,
    );
  });
});

// ── Pi docs mapping ──────────────────────────────────────────────────────

const DOCS = "/home/node/.agent/docs";

describe("toRemote: pi docs mapping", () => {
  it("maps a path inside docsPath to /home/node/.agent/docs/...", () => {
    const c = ctx({
      docsPath: "/home/jack/.nvm/versions/node/v25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/docs",
    });
    expect(
      toRemote(
        "/home/jack/.nvm/versions/node/v25.2.1/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md",
        c,
      ),
    ).toBe("/home/node/.agent/docs/extensions.md");
  });

  it("maps the docsPath directory itself to /home/node/.agent/docs", () => {
    const docsPath = "/opt/pi/docs";
    const c = ctx({ docsPath });
    expect(toRemote(docsPath, c)).toBe(DOCS);
  });

  it("passes through an already-remote docs path", () => {
    const c = ctx({ docsPath: "/opt/pi/docs" });
    expect(toRemote("/home/node/.agent/docs/README.md", c)).toBe(
      "/home/node/.agent/docs/README.md",
    );
  });

  it("docs mapping takes priority over hostCwd when path is in both", () => {
    // docsPath is inside hostCwd — docs check comes first
    const c = ctx({
      hostCwd: "/opt",
      docsPath: "/opt/pi/docs",
    });
    expect(toRemote("/opt/pi/docs/reference.md", c)).toBe(
      `${DOCS}/reference.md`,
    );
  });

  it("falls back to hostCwd when docsPath is undefined", () => {
    const c = ctx({ docsPath: undefined });
    expect(toRemote("file.txt", c)).toBe("/workspace/file.txt");
  });

  it("falls back to hostCwd when docsPath is an empty string", () => {
    const c = ctx({ docsPath: "" });
    expect(toRemote("file.txt", c)).toBe("/workspace/file.txt");
  });
});