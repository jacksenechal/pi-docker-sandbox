import { describe, it, expect, vi } from "vitest";
import { createUIContext } from "../types";
import type { PIContext, UIContext } from "../types";

describe("createUIContext", () => {
  function fakePIContext(): PIContext & { _reloadCalls: number; _notifications: string[] } {
    const self = {
      _reloadCalls: 0,
      _notifications: [] as string[],
      ui: {
        notify(msg: string, _severity?: string) { self._notifications.push(msg); },
        confirm: vi.fn().mockResolvedValue(true),
        setStatus: vi.fn(),
      },
      reload() { self._reloadCalls++; return Promise.resolve(); },
    };
    return self;
  }

  it("delegates notify to ctx.ui.notify", () => {
    const ctx = fakePIContext();
    const ui = createUIContext(ctx);
    ui.notify("hello", "info");
    expect(ctx._notifications).toContain("hello");
  });

  it("delegates confirm to ctx.ui.confirm", async () => {
    const ctx = fakePIContext();
    const ui = createUIContext(ctx);
    const result = await ui.confirm("title", "body");
    expect(result).toBe(true);
    expect(ctx.ui.confirm).toHaveBeenCalledWith("title", "body");
  });

  it("delegates setStatus to ctx.ui.setStatus", () => {
    const ctx = fakePIContext();
    const ui = createUIContext(ctx);
    ui.setStatus("sandbox", "active");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("sandbox", "active");
  });

  it("delegates reload to ctx.reload — NOT ctx.ui", () => {
    const ctx = fakePIContext();
    const ui = createUIContext(ctx);
    ui.reload();
    // This is the key assertion: reload() must call ctx.reload(), not ctx.ui.reload()
    expect(ctx._reloadCalls).toBe(1);
    // ctx.ui has no reload property — if createUIContext incorrectly wired to
    // ctx.ui.reload, this test would fail because ctx.ui doesn't have reload
    expect(ctx.ui).not.toHaveProperty("reload");
  });
});
