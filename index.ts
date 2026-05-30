/**
 * agent-sandbox — lightweight Docker sandbox for pi coding agent.
 *
 * Default: complete isolation (no network, no host mounts).
 * The container has an internal /workspace directory that is always
 * writable, so bash/read/write/edit work even with no mounts.
 *
 * Opt in to networking, CWD mount, skills mount, SSH agent forwarding.
 *
 * Flags:
 *   --no-sandbox          disable sandbox entirely (sandbox is on by default)
 *   --sandbox-network     allow outbound network (needed for browser tool)
 *   --sandbox-mount-cwd   bind-mount the project at /workspace (rw)
 *   --sandbox-mount-skills mount ~/.agents/skills and ~/.pi/agent/skills at /skills (ro)
 *   --sandbox-mount-ssh   forward $SSH_AUTH_SOCK into the container
 *   --sandbox-name <n>    reusable container name (default: pi-agent-<dir>-<hash>)
 *   --sandbox-memory <m>  memory limit (default: 4g)
 *   --sandbox-cpus <c>    CPU limit (default: 2)
 *
 * Commands (all toggles destroy and recreate the container — in-container
 * state like installed tools or temp files is lost on restart):
 *   /sandbox          show container status and resource usage
 *   /sandbox doctor   verify tools inside the container
 *   /sandbox stop            stop the sandbox container
 *   /sandbox restart         restart the sandbox container
 *   /sandbox rebuild         rebuild the sandbox Docker image
 *   /sandbox prune           remove all stopped pi-agent-* containers
 *   /sandbox network on|off  toggle outbound network access
 *   /sandbox ssh on|off      toggle SSH agent forwarding
 *   /sandbox cwd on|off      toggle project CWD mount
 *   /sandbox skills on|off   toggle skill directory mounts
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionUIContext,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────

const DOCKER = "docker";
const IMAGE = "agent-sandbox:latest";
const REMOTE_WORKSPACE = "/workspace";
const REMOTE_SKILLS = "/skills";
const LOG_FILE = "/tmp/agent-sandbox.log";

function log(msg: string) {
	try { writeFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch {}
}

// ── Module state ─────────────────────────────────────────────────────

interface Container {
	name: string;
	hostCwd: string;
	keep: boolean;
	hasNetwork: boolean;
	hasCwd: boolean;
	hasSkills: boolean;
	hasSsh: boolean;
	memory: string;
	cpus: string;
	/** Set of host paths mounted as skills (for path translation). */
	skillSources: string[];
}

let sandbox: Container | null = null;
const getContainer = () => sandbox;

// ── Toggle overrides ────────────────────────────────────────────────
// Set by /sandbox <feature> on|off commands. Take precedence over CLI flags.
// Persisted to disk so they survive ctx.reload() (which reloads the module).
function getTogglesFile(): string {
	const hash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 6);
	return `/tmp/agent-sandbox-toggles-${hash}.json`;
}

function readToggles(): Record<string, boolean> {
	try {
		const file = getTogglesFile();
		if (existsSync(file)) {
			return JSON.parse(readFileSync(file, "utf-8"));
		}
	} catch {}
	return {};
}

function writeToggles(t: Record<string, boolean>): void {
	try {
		writeFileSync(getTogglesFile(), JSON.stringify(t));
	} catch {}
}

function getToggles(): Record<string, boolean> {
	return readToggles();
}

// ── Child process helpers ────────────────────────────────────────────

function spawnOut(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (d) => out.push(d));
		child.stderr.on("data", (d) => err.push(d));
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: -1, stdout: "", stderr: "spawn error", timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout: Buffer.concat(out).toString(),
				stderr: Buffer.concat(err).toString(),
				timedOut,
			});
		});
	});
}

async function docker(args: string[], timeoutMs = 30000) {
	const r = await spawnOut(DOCKER, args, timeoutMs);
	return { ok: r.code === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr };
}

/** Synchronously stop a container. Used in signal/exit handlers where async is unavailable. */
function stopSync(name: string): void {
	spawnSync(DOCKER, ["rm", "-f", name], { stdio: "ignore", timeout: 5000 });
}

/** Execute a command inside the container, return trimmed stdout. */
async function execCapture(container: Container, cmd: string, timeoutMs = 30000): Promise<string> {
	const r = await spawnOut(DOCKER, ["exec", container.name, "sh", "-c", cmd], timeoutMs);
	if (r.code !== 0 || r.timedOut) {
		const detail = r.stderr.trim() || r.stdout.trim() || `code=${r.code}`;
		throw new Error(`exec failed: ${detail}`);
	}
	return r.stdout.trim();
}

/** POSIX-safe shell quoting. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Container name ───────────────────────────────────────────────────

function deriveName(cwd: string): string {
	const base = cwd.split("/").filter(Boolean).pop() || "agent";
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 6);
	return `pi-agent-${base}-${hash}`;
}

// ── Skill directory discovery ────────────────────────────────────────

function discoverSkillDirs(): string[] {
	const roots = [
		join(homedir(), ".agents", "skills"),
		join(homedir(), ".pi", "agent", "skills"),
	];
	const dirs: string[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		try {
			for (const entry of readdirSync(root)) {
				const full = join(root, entry);
				try {
					if (statSync(full).isDirectory() && !dirs.includes(full)) {
						dirs.push(full);
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}
	return dirs;
}

// ── Extension directory (for rebuild) ────────────────────────────────

function getExtensionDir(): string {
	const candidates = [
		resolvePath(homedir(), "workspace", "agent-sandbox"),
		resolvePath(homedir(), ".pi", "agent", "extensions", "sandbox"),
	];
	for (const dir of candidates) {
		if (existsSync(join(dir, "Dockerfile"))) return dir;
	}
	throw new Error("Cannot find agent-sandbox Dockerfile. Expected at ~/workspace/agent-sandbox/");
}

// ── Path translation ─────────────────────────────────────────────────

/**
 * Translate a host path to its container-side equivalent.
 *
 *   - /workspace/… passes through (container-absolute path)
 *   - /skills/… passes through
 *   - When CWD is mounted: paths inside hostCwd → /workspace/…
 *   - When CWD is NOT mounted: relative paths → /workspace/… (internal)
 *   - Absolute paths (when CWD is not mounted) → rejected
 *   - Paths inside a skill dir → /skills/…
 */
function toRemote(hostPath: string, c: Container): string {
	// Already a container absolute path.
	if (hostPath === REMOTE_WORKSPACE || hostPath.startsWith(`${REMOTE_WORKSPACE}/`)) {
		return hostPath;
	}
	if (hostPath === REMOTE_SKILLS || hostPath.startsWith(`${REMOTE_SKILLS}/`)) {
		return hostPath;
	}

	// Check if path belongs to a mounted skill directory.
	if (c.hasSkills) {
		const abs = resolvePath(c.hostCwd, hostPath);
		for (const src of c.skillSources) {
			if (abs === src || abs.startsWith(`${src}/`)) {
				const rel = abs.slice(src.length + 1);
				return rel ? `${REMOTE_SKILLS}/${rel}` : REMOTE_SKILLS;
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

// ── Tool operation adapters ──────────────────────────────────────────

function readOps(c: Container) {
	return {
		readFile: (p: string) => execCapture(c, `cat ${q(toRemote(p, c))}`).then((x) => Buffer.from(x)),
		access: (p: string) => execCapture(c, `test -r ${q(toRemote(p, c))}`).then(() => {}),
		detectImageMimeType: async (p: string) => {
			try {
				const m = await execCapture(c, `file --mime-type -b ${q(toRemote(p, c))}`);
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch { return null; }
		},
	};
}

function writeOps(c: Container) {
	return {
		writeFile: async (p: string, content: Uint8Array | string) => {
			const remote = toRemote(p, c);
			const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			const b64 = buf.toString("base64");
			await execCapture(c, `printf %s ${q(b64)} | base64 -d > ${q(remote)}`);
		},
		mkdir: async (dir: string) => {
			await execCapture(c, `mkdir -p ${q(toRemote(dir, c))}`);
		},
	};
}

function editOps(c: Container) {
	const ro = readOps(c);
	const wo = writeOps(c);
	return { readFile: ro.readFile, access: ro.access, writeFile: wo.writeFile };
}

function bashOps(c: Container) {
	return {
		exec: (command: string, directory: string, opts: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
			const remoteCwd = toRemote(directory, c);
			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const child = spawn(DOCKER, ["exec", c.name, "sh", "-c", `cd ${q(remoteCwd)} && ${command}`], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				const timer = opts.timeout
					? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeout * 1000)
					: undefined;
				child.stdout.on("data", opts.onData);
				child.stderr.on("data", opts.onData);
				child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
				const onAbort = () => child.kill("SIGKILL");
				opts.signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					opts.signal?.removeEventListener("abort", onAbort);
					if (opts.signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

// ── System prompt injection ──────────────────────────────────────────

function buildSystemPrompt(c: Container, originalCwd: string): string {
	const parts = [
		`Current working directory: ${c.hasCwd ? REMOTE_WORKSPACE : "/"} (sandboxed Docker container ${c.name})`,
	];
	if (c.hasCwd) {
		parts.push(`Host project ${originalCwd} is mounted read-write at ${REMOTE_WORKSPACE}. Changes to ${REMOTE_WORKSPACE} persist on the host.`);
	} else {
		parts.push(`The host project is NOT mounted. ${REMOTE_WORKSPACE} is an ephemeral directory inside the container — all file writes are lost when the session ends. Use --sandbox-mount-cwd to persist work to the host project.`);
	}
	if (c.hasSkills) {
		parts.push(
			`Agent skills are mounted read-only at ${REMOTE_SKILLS}/. Read skill files directly (e.g. ${REMOTE_SKILLS}/<name>/SKILL.md).`,
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

// ── Browser tool (only when network is enabled) ──────────────────────

function createBrowserTool(c: Container) {
	return {
		name: "browser",
		label: "Browser (sandboxed)",
		description: "Navigate the web using a headless Chromium browser (Playwright). Use when you need to view a webpage, click elements, fill forms, or extract content.",
		promptSnippet: "Navigate and interact with web pages using Playwright",
		promptGuidelines: [
			"Use the browser tool to view web pages, interact with elements, and extract page content.",
			"The browser runs headless inside the sandbox container. All navigation is isolated.",
			"Write the full Playwright script — the tool executes it as `node -e '<script>'`.",
			"Use `page.goto(url)` to navigate, `page.content()` or `page.locator(…).textContent()` to extract text.",
		],
		parameters: null as any,
		async execute(
			_toolCallId: string,
			params: { script: string },
			_signal: AbortSignal,
			onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
			_ctx: any,
		) {
			onUpdate?.({ content: [{ type: "text", text: "Running browser script…" }] });
			try {
				const result = await execCapture(c, `node -e ${q(params.script)}`, 30000);
				return { content: [{ type: "text", text: result }], details: {} };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Browser error: ${e.message}` }], details: {}, isError: true };
			}
		},
	};
}

// ── Extension entry point ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	log("extension loading…");

	// ── Flags ───────────────────────────────────────────────────────
	pi.registerFlag("sandbox", {
		description: "Run tools inside a Docker sandbox (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-sandbox", {
		description: "Disable the Docker sandbox",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-network", {
		description: "Allow outbound network from the sandbox",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-mount-cwd", {
		description: "Mount the project directory at /workspace (rw)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-mount-skills", {
		description: "Mount agent skill directories at /skills (ro)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-mount-ssh", {
		description: "Forward SSH agent socket into the container",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-name", {
		description: "Reusable container name (default: auto-generated from project path)",
		type: "string",
	});
	pi.registerFlag("sandbox-memory", {
		description: "Memory limit (default: 4g)",
		type: "string",
		default: "4g",
	});
	pi.registerFlag("sandbox-cpus", {
		description: "CPU limit (default: 2)",
		type: "string",
		default: "2",
	});

	const localCwd = process.cwd();
	log(`localCwd=${localCwd}`);

	// Snapshot built-in tools so we can fall back when sandbox is off.
	const hostRead = createReadTool(localCwd);
	const hostWrite = createWriteTool(localCwd);
	const hostEdit = createEditTool(localCwd);
	const hostBash = createBashTool(localCwd);

	// Override built-in tools with sandbox-aware versions.
	// When sandbox is active, forward to container; otherwise delegate to host.
	pi.registerTool({
		...hostRead,
		async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
			const c = getContainer();
			if (!c) return hostRead.execute(id, params, signal, onUpdate);
			const tool = createReadTool(localCwd, { operations: readOps(c) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...hostWrite,
		async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
			const c = getContainer();
			if (!c) return hostWrite.execute(id, params, signal, onUpdate);
			const tool = createWriteTool(localCwd, { operations: writeOps(c) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...hostEdit,
		async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
			const c = getContainer();
			if (!c) return hostEdit.execute(id, params, signal, onUpdate);
			const tool = createEditTool(localCwd, { operations: editOps(c) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...hostBash,
		label: "bash (sandboxed)",
		async execute(id: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) {
			const c = getContainer();
			if (!c) return hostBash.execute(id, params, signal, onUpdate);
			const tool = createBashTool(localCwd, { operations: bashOps(c) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	// Register browser tool conditionally — it only works with network.
	let browserToolRegistered = false;
	function ensureBrowserTool(c: Container) {
		if (browserToolRegistered) return;
		if (!c.hasNetwork) return;
		const { Type } = require("typebox");
		const tool = createBrowserTool(c);
		tool.parameters = Type.Object({
			script: Type.String({ description: "Playwright Node.js script to execute. Use `const { chromium } = require('playwright');` at the start." }),
		});
		pi.registerTool(tool as any);
		browserToolRegistered = true;
	}

	// ── User bash override ──────────────────────────────────────────
	pi.on("user_bash", () => {
		const c = getContainer();
		if (!c) return;
		return { operations: bashOps(c) };
	});

	// ── System prompt ───────────────────────────────────────────────
	pi.on("before_agent_start", (event) => {
		const c = getContainer();
		if (!c) return;
		return {
			systemPrompt: event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				buildSystemPrompt(c, localCwd),
			),
		};
	});

	// ── Container lifecycle ─────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		log(`session_start flags: sandbox=${pi.getFlag("sandbox")}`);

		if ((pi.getFlag("no-sandbox") as boolean) || !(pi.getFlag("sandbox") as boolean)) {
			log("sandbox disabled via flag, skipping");
			return;
		}

		try {
			// Check Docker is available.
			const { ok: haveDocker } = await docker(["version"], 5000);
			log(`docker version: ok=${haveDocker}`);
			if (!haveDocker) {
				ctx.ui.notify("Docker not available. Running without sandbox.", "warning");
				return;
			}

			// Check image exists, pull if needed.
			const { ok: imageExists } = await docker(["image", "inspect", IMAGE], 10000);
			log(`image ${IMAGE} exists: ${imageExists}`);
			if (!imageExists) {
				ctx.ui.notify(`Pulling sandbox image ${IMAGE}…`);
				const { ok: pulled } = await docker(["pull", IMAGE], 120000);
				if (!pulled) {
					ctx.ui.notify(`Failed to pull ${IMAGE}. Build it:\n  docker build -t ${IMAGE} -f Dockerfile .`, "error");
					return;
				}
			}

			// Read flags.
			const activeToggles = getToggles();
		const hasNetwork = activeToggles.network ?? (pi.getFlag("sandbox-network") as boolean);
			const hasCwd = activeToggles.cwd ?? (pi.getFlag("sandbox-mount-cwd") as boolean);
			const hasSkills = activeToggles.skills ?? (pi.getFlag("sandbox-mount-skills") as boolean);
			const hasSsh = activeToggles.ssh ?? (pi.getFlag("sandbox-mount-ssh") as boolean);
			const nameFlag = pi.getFlag("sandbox-name") as string | undefined;
			const memory = (pi.getFlag("sandbox-memory") as string) || "4g";
			const cpus = (pi.getFlag("sandbox-cpus") as string) || "2";

			const containerName = nameFlag || deriveName(localCwd);
			log(`container=${containerName} network=${hasNetwork} cwd=${hasCwd} skills=${hasSkills} ssh=${hasSsh}`);

			// Remove stale container with same name.
			await docker(["rm", "-f", containerName], 5000);

			// Build docker run args.
			const args: string[] = [
				"run", "-d", "--rm", "--name", containerName,
				"--user", "1000:1000",
				"--memory", memory,
				"--cpus", cpus,
				"--cap-drop", "ALL",
				"--security-opt", "no-new-privileges",
				"--pids-limit", "512",
			];

			if (!hasNetwork) {
				args.push("--network", "none");
			}

			// Optional mounts.
			if (hasCwd) {
				args.push("-v", `${localCwd}:${REMOTE_WORKSPACE}`);
			}

			const skillSources: string[] = [];
			if (hasSkills) {
				const skillDirs = discoverSkillDirs();
				for (let i = 0; i < skillDirs.length; i++) {
					const dir = skillDirs[i];
					const name = dir.split("/").filter(Boolean).pop() || `skill-${i}`;
					args.push("-v", `${dir}:${REMOTE_SKILLS}/${name}:ro`);
					skillSources.push(dir);
				}
			}

			if (hasSsh && process.env.SSH_AUTH_SOCK) {
				const sock = process.env.SSH_AUTH_SOCK;
				args.push("-v", `${sock}:${sock}`);
				args.push("-e", `SSH_AUTH_SOCK=${sock}`);
			}

			args.push(IMAGE, "sleep", "infinity");

			// Start container.
			log(`docker run with ${args.length} args`);
			const { ok: started, stderr: runErr } = await docker(args, 60000);
			if (!started) {
				log(`docker run FAILED: ${runErr}`);
				ctx.ui.notify(`Failed to start sandbox container: ${runErr}`, "error");
				return;
			}
			log(`docker run OK`);

			sandbox = {
				name: containerName,
				hostCwd: localCwd,
				keep: false,
				hasNetwork,
				hasCwd,
				hasSkills,
				hasSsh,
				memory,
				cpus,
				skillSources,
			};

			// Register cleanup. Uses synchronous stop for signal handlers (async
		// doesn't work in process.on("exit")), async for session_shutdown.
			const cleanup = () => {
				const c = sandbox;
				if (!c || c.keep) return;
				stopSync(c.name);
				sandbox = null;
			};
			process.once("exit", cleanup);
			process.once("SIGINT", () => { cleanup(); process.exit(130); });
			process.once("SIGTERM", () => { cleanup(); process.exit(143); });

			// Smoke test.
			const smoke = await execCapture(sandbox, "id -un && pwd", 10000);
			log(`smoke test OK: ${JSON.stringify(smoke)}`);

			// Status display.
			const flagParts: string[] = [];
			if (hasNetwork) flagParts.push("net");
			if (hasCwd) flagParts.push("cwd");
			if (hasSkills) flagParts.push("skills");
			if (hasSsh) flagParts.push("ssh");
			const flagStr = flagParts.length ? ` [${flagParts.join(", ")}]` : " [isolated]";

			ctx.ui.setStatus("sandbox", `🛡 ${containerName}${flagStr} mem=${memory} cpu=${cpus}`);
			ctx.ui.notify(
				`🛡 Sandbox up: ${containerName}${flagStr}\n${smoke}\nmemory=${memory} cpu=${cpus} network=${hasNetwork ? "on" : "off"} cwd=${hasCwd ? "mounted" : "none"} skills=${hasSkills ? "mounted" : "none"} ssh=${hasSsh ? "forwarded" : "none"}`,
				"info",
			);

			// Activate browser tool if network is on.
			ensureBrowserTool(sandbox);
			log(`session_start complete, sandbox active`);
		} catch (e: any) {
			const msg = e instanceof Error ? e.message : String(e);
			log(`session_start ERROR: ${msg}`);
			// Clean up container if it was created.
			if (sandbox) {
				docker(["kill", sandbox.name], 2000).catch(() => {});
			}
			sandbox = null;
			ctx.ui.notify(`Sandbox init failed: ${msg}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		const c = getContainer();
		if (!c) return;
		if (!c.keep) {
			await docker(["kill", c.name], 2000).catch(() => {});
		}
		sandbox = null;
	});

	// ── /sandbox command ────────────────────────────────────────────

	pi.registerCommand("sandbox", {
		description: "Sandbox management. status, doctor, stop, restart, rebuild, prune, network/ssh/cwd/skills on|off",
		handler: async (args: string, ctx: ExtensionUIContext) => {
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";

			switch (sub) {
				case "status": {
					const c = getContainer();
					if (!c) {
						ctx.ui.notify("Sandbox is not active.\nUse --sandbox-network to enable networking, --sandbox-mount-cwd to mount the project.", "info");
						return;
					}
					const info = await execCapture(c, "id && uname -a && df -h / 2>/dev/null | tail -1");
					const flagParts: string[] = [];
					if (c.hasNetwork) flagParts.push("network");
					if (c.hasCwd) flagParts.push("cwd");
					if (c.hasSkills) flagParts.push("skills");
					if (c.hasSsh) flagParts.push("ssh-agent");
				const toggles = getToggles(); const togglesOn = Object.entries(toggles).filter(([,v]) => v !== undefined);
				const toggleStr = togglesOn.length ? " | toggles: " + togglesOn.map(([k,v]) => `${k}=${v ? "on" : "off"}`).join(" ") : "";
					ctx.ui.notify([
						`🛡 Sandbox: ${c.name}`,
						`Flags: ${flagParts.length ? flagParts.join(", ") : "fully isolated"}${toggleStr}`,
						`Resources: memory=${c.memory}, cpus=${c.cpus}`,
						`Host CWD: ${c.hostCwd}`,
						"",
						info,
					].join("\n"), "info");
					break;
				}
				case "doctor": {
					const c = getContainer();
					if (!c) { ctx.ui.notify("Sandbox is not active.", "info"); return; }
					const script = [
						'for cmd in sh bash node npm git rg fd jq curl ssh chromium; do',
						'  if command -v "$cmd" >/dev/null 2>&1; then printf "  ok   %-12s -> %s\\n" "$cmd" "$(command -v "$cmd")"; else printf "  MISS %-12s\\n" "$cmd"; fi',
						"done",
						"echo",
						'node --version 2>&1 | sed "s/^/  node version: /"',
						'chromium --version 2>&1 | sed "s/^/  chromium: /"',
						'[ -f /usr/local/lib/node_modules/playwright/package.json ] && echo "  playwright: installed" || echo "  playwright: MISSING"',
					].join("\n");
					const out = await execCapture(c, script, 20000);
					ctx.ui.notify(`Sandbox doctor:\n${out}`, "info");
					break;
				}
				case "network": {
					const action = args.trim().split(/\s+/)[1]?.toLowerCase();
					if (action === "on" || action === "off") {
						const enable = action === "on";
						if (enable && !(await ctx.ui.confirm("Enable network?", "This will allow the sandbox to make outbound connections. The browser tool will become available."))) break;
						toggles.network = enable;
						ctx.ui.notify(`Network ${enable ? "enabled" : "disabled"}. Restarting sandbox…`, "info");
						// Kill current container and reload
						const c = getContainer();
						if (c) { await docker(["kill", c.name], 3000); sandbox = null; }
						await ctx.reload();
					} else {
						ctx.ui.notify("Usage: /sandbox network on|off", "info");
					}
					break;
				}
				case "ssh": {
					const action = args.trim().split(/\s+/)[1]?.toLowerCase();
					if (action === "on" || action === "off") {
						const enable = action === "on";
						if (enable && !process.env.SSH_AUTH_SOCK) {
							ctx.ui.notify("SSH_AUTH_SOCK is not set. SSH agent forwarding won't work.", "warning");
						}
						if (!(await ctx.ui.confirm(
							enable ? "Enable SSH agent?" : "Disable SSH agent?",
							enable
								? "Forward the host SSH agent into the sandbox. Git over SSH will use your keys. Any in-container state will be lost on restart."
								: "Remove SSH agent access. Git over SSH will stop working. Any in-container state will be lost on restart."
						))) break;
						toggles.ssh = enable;
						ctx.ui.notify(`SSH agent ${enable ? "enabled" : "disabled"}. Restarting sandbox…`, "info");
						const c = getContainer();
						if (c) { await docker(["kill", c.name], 3000); sandbox = null; }
						await ctx.reload();
					} else {
						ctx.ui.notify("Usage: /sandbox ssh on|off", "info");
					}
					break;
				}
				case "cwd": {
					const action = args.trim().split(/\s+/)[1]?.toLowerCase();
					if (action === "on" || action === "off") {
						const enable = action === "on";
						if (!(await ctx.ui.confirm(
							enable ? "Mount project CWD?" : "Unmount project CWD?",
							enable
								? `Mount ${process.cwd()} at /workspace (read-write). The container's current /workspace contents will be hidden by the mount. Any in-container state will be lost on restart.`
								: "Unmount the project directory. /workspace will become an ephemeral container directory. Any in-container state will be lost on restart."
						))) break;
						toggles.cwd = enable;
						ctx.ui.notify(`CWD mount ${enable ? "enabled" : "disabled"}. Restarting sandbox…`, "info");
						const c = getContainer();
						if (c) { await docker(["kill", c.name], 3000); sandbox = null; }
						await ctx.reload();
					} else {
						ctx.ui.notify("Usage: /sandbox cwd on|off", "info");
					}
					break;
				}
				case "skills": {
					const action = args.trim().split(/\s+/)[1]?.toLowerCase();
					if (action === "on" || action === "off") {
						const enable = action === "on";
						toggles.skills = enable;
						ctx.ui.notify(`Skills mount ${enable ? "enabled" : "disabled"}. Restarting sandbox (in-container state will be lost)…`, "info");
						const c = getContainer();
						if (c) { await docker(["kill", c.name], 3000); sandbox = null; }
						await ctx.reload();
					} else {
						ctx.ui.notify("Usage: /sandbox skills on|off", "info");
					}
					break;
				}
				case "stop":
				case "kill":
				case "restart": {
					const c = getContainer();
					const name = c?.name;
					if (c) {
						await docker(["kill", c.name], 3000);
						sandbox = null;
					}
					if (sub === "restart" || !name) {
						ctx.ui.notify(name ? `Sandbox ${name} killed. Reconnecting…` : "Starting new sandbox…", "info");
						await ctx.reload();
					} else {
						ctx.ui.notify(`Sandbox ${name} stopped (auto-removed).`, "info");
					}
					break;
				}
				case "rebuild": {
					ctx.ui.notify("Rebuilding sandbox image…");
					const { ok, stdout, stderr } = await docker(["build", "-t", IMAGE, getExtensionDir()], 120000);
					if (ok) {
						ctx.ui.notify(`Sandbox image rebuilt.\n${stdout.slice(-500)}`, "info");
					} else {
						ctx.ui.notify(`Rebuild failed:\n${stderr.slice(-1000) || stdout.slice(-1000)}`, "error");
					}
					break;
				}
				case "prune": {
					const c = getContainer();
					const currentName = c?.name;
					const { stdout } = await docker(["ps", "-a", "--filter", "name=pi-agent-", "--format", "{{.Names}}"], 5000);
					const names = stdout.trim().split("\n").filter(Boolean);
					if (names.length === 0) {
						ctx.ui.notify("No sandbox containers found.", "info");
						break;
					}
					let removed = 0;
					for (const name of names) {
						if (name === currentName) continue;
						await docker(["rm", "-f", name], 5000);
						removed++;
					}
					ctx.ui.notify(`Pruned ${removed} stopped sandbox container${removed !== 1 ? "s" : ""}.`, "info");
					break;
				}
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}\nTry: status, doctor, stop, restart, rebuild, prune, network, ssh, cwd, skills`, "info");
			}
		},
	});

	log("extension loaded successfully");
}
