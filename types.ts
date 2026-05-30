// ── Process abstraction ────────────────────────────────────────────────

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(bin: string, args: string[], timeoutMs: number): Promise<ProcessResult>;
}

// ── Docker abstraction ──────────────────────────────────────────────────

export interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface DockerClient {
  /** Run a docker CLI command. */
  run(args: string[], timeoutMs?: number): Promise<DockerResult>;
  /** Execute a command inside a running container. Returns trimmed stdout. */
  exec(container: string, cmd: string, timeoutMs?: number): Promise<string>;
  /** Stop a running container (docker kill). */
  stop(container: string): Promise<void>;
  /** Force-remove a container (docker rm -f). */
  rm(container: string): Promise<void>;
  /** Check whether the docker daemon is reachable. */
  version(): Promise<boolean>;
  /** Check whether an image exists locally. */
  imageExists(image: string): Promise<boolean>;
  /** Pull an image from a registry. */
  pull(image: string): Promise<boolean>;
  /** Build an image from a Dockerfile directory. */
  build(dir: string, image: string): Promise<DockerResult>;
}

// ── File I/O abstraction (for toggle persistence) ────────────────────────

export interface FileStore {
  /** Read a file as a UTF-8 string, or null if it doesn't exist. */
  read(path: string): string | null;
  /** Write a UTF-8 string to a file (overwrites). */
  write(path: string, data: string): void;
  /** Check whether a file exists. */
  exists(path: string): boolean;
}

// ── Skill discovery abstraction ──────────────────────────────────────────

export interface SkillResolver {
  /** Return absolute paths to skill directories on the host. */
  discover(): string[];
}

// ── Sandbox configuration (plain data, no pi SDK dependency) ─────────────

export interface SandboxFlags {
  network: boolean;
  mountCwd: boolean;
  mountSkills: boolean;
  mountSsh: boolean;
  containerName?: string;
  memory: string;
  cpus: string;
}

// ── Path translation context (subset of Container needed by toRemote) ────

export interface PathContext {
  hostCwd: string;
  hasCwd: boolean;
  hasSkills: boolean;
  skillSources: string[];
}

// ── UI abstraction (for command handlers) ────────────────────────────────

export interface UIContext {
  notify(message: string, severity?: "info" | "warning" | "error"): void;
  confirm(title: string, body: string): Promise<boolean>;
  reload(): Promise<void>;
  setStatus(key: string, text: string): void;
}

// ── Sandbox handle (subset of SandboxManager for consumers) ──────────────

export interface SandboxHandle {
  readonly name: string;
  readonly hostCwd: string;
  readonly hasCwd: boolean;
  readonly hasNetwork: boolean;
  readonly hasSkills: boolean;
  readonly hasSsh: boolean;
  readonly memory: string;
  readonly cpus: string;
  exec(cmd: string, timeoutMs?: number): Promise<string>;
  toRemote(hostPath: string): string;
  stop(): Promise<void>;
}