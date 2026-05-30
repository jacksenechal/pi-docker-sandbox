import type { FileStore } from "./types";

/**
 * Persisted key-value store for sandbox feature toggles.
 *
 * Each set() writes through to disk immediately so that toggles survive
 * ctx.reload() (which reloads the module). Reads are cached in-memory
 * after the first access.
 */
export class ToggleStore {
  private cache: Record<string, boolean> | null = null;

  constructor(
    private file: FileStore,
    private path: string,
  ) {}

  get(key: string, fallback?: boolean): boolean | undefined {
    this.cache ??= this.load();
    return key in this.cache ? this.cache[key] : fallback;
  }

  set(key: string, value: boolean): void {
    this.cache ??= this.load();
    this.cache[key] = value;
    this.persist();
  }

  getAll(): Record<string, boolean> {
    this.cache ??= this.load();
    return { ...this.cache };
  }

  // ── private ──────────────────────────────────────────────────────

  private load(): Record<string, boolean> {
    const raw = this.file.read(this.path);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private persist(): void {
    this.file.write(this.path, JSON.stringify(this.cache ?? {}));
  }
}
