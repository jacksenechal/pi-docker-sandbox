import { describe, it, expect, beforeEach } from "vitest";
import { ToggleStore } from "../toggles";
import type { FileStore } from "../types";

// ── Test double ──────────────────────────────────────────────────────────

class InMemoryFileStore implements FileStore {
  private files = new Map<string, string>();

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, data: string): void {
    this.files.set(path, data);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }
}

const TEST_PATH = "/tmp/test-toggles.json";

// ── Tests ────────────────────────────────────────────────────────────────

describe("ToggleStore", () => {
  let store: ToggleStore;
  let fs: InMemoryFileStore;

  beforeEach(() => {
    fs = new InMemoryFileStore();
    store = new ToggleStore(fs, TEST_PATH);
  });

  describe("get", () => {
    it("returns undefined for a key that has never been set", () => {
      expect(store.get("network")).toBeUndefined();
    });

    it("returns the fallback value when key is unset", () => {
      expect(store.get("network", false)).toBe(false);
      expect(store.get("network", true)).toBe(true);
    });

    it("returns a previously set value", () => {
      store.set("network", true);
      expect(store.get("network")).toBe(true);
    });

    it("returns false when set to false (not undefined)", () => {
      store.set("network", false);
      expect(store.get("network")).toBe(false);
      expect(store.get("network", true)).toBe(false); // fallback ignored
    });

    it("persists across separate store instances (reads from disk)", () => {
      store.set("network", true);
      // Create a new store pointing at the same file
      const store2 = new ToggleStore(fs, TEST_PATH);
      expect(store2.get("network")).toBe(true);
    });
  });

  describe("set", () => {
    it("writes to disk immediately", () => {
      store.set("ssh", false);
      expect(fs.exists(TEST_PATH)).toBe(true);
      const raw = JSON.parse(fs.read(TEST_PATH)!);
      expect(raw.ssh).toBe(false);
    });

    it("overwrites a previously set key", () => {
      store.set("network", true);
      store.set("network", false);
      expect(store.get("network")).toBe(false);
    });
  });

  describe("getAll", () => {
    it("returns empty object when nothing is set", () => {
      expect(store.getAll()).toEqual({});
    });

    it("returns all set key-value pairs", () => {
      store.set("network", true);
      store.set("cwd", false);
      expect(store.getAll()).toEqual({ network: true, cwd: false });
    });
  });

  describe("flush", () => {
    it("persists in-memory state to disk", () => {
      store.set("skills", true);
      // Verify it's on disk already (auto-flush on set)
      expect(JSON.parse(fs.read(TEST_PATH)!)).toHaveProperty("skills", true);
    });
  });

  describe("empty state", () => {
    it("getAll returns empty object for nonexistent file", () => {
      const fresh = new ToggleStore(fs, "/tmp/nonexistent.json");
      expect(fresh.getAll()).toEqual({});
    });

    it("get returns undefined for nonexistent file", () => {
      const fresh = new ToggleStore(fs, "/tmp/nonexistent.json");
      expect(fresh.get("anything")).toBeUndefined();
    });
  });

  describe("malformed file", () => {
    it("survives corrupted JSON by returning empty state", () => {
      fs.write(TEST_PATH, "not valid json {[");
      const store = new ToggleStore(fs, TEST_PATH);
      expect(store.getAll()).toEqual({});
      expect(store.get("network")).toBeUndefined();
    });
  });
});
