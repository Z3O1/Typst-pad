import { describe, expect, it, vi } from "vitest";
import { createSourceScrollSync, type ScrollPane } from "./source-scroll-sync";

function setup() {
  let context: string | null = "session:1/revision:1/geometry:1/layout:1";
  let callback: (() => void) | null = null;
  const requests: { pane: ScrollPane; resolve: (value: number | null) => void }[] = [];
  const apply = vi.fn();
  const sync = createSourceScrollSync<number>({
    context: () => context,
    frame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelFrame: () => {
      callback = null;
    },
    resolve: (pane) => new Promise((resolve) => requests.push({ pane, resolve })),
    apply,
  });
  return {
    sync,
    requests,
    apply,
    setContext: (value: string | null) => {
      context = value;
    },
    frame: () => {
      const fn = callback;
      callback = null;
      fn?.();
    },
    source: () => sync.observe("source", () => ({ pos: 42, viewportRatio: 0.2 })),
    preview: () =>
      sync.observe("preview", () => ({ point: { page: 3, xPt: 20, yPt: 99 }, viewportRatio: 0.2 })),
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("source-scroll-sync shared direction contract", () => {
  it("coalesces scroll bursts into a single animation-frame query", async () => {
    const t = setup();
    for (let i = 0; i < 100; i++) t.source();
    expect(t.requests).toHaveLength(0);
    t.frame();
    expect(t.requests).toHaveLength(1);
    t.requests[0].resolve(7);
    await flush();
    expect(t.apply).toHaveBeenCalledExactlyOnceWith("source", 7);
  });

  it("keeps one in-flight query across both directions and discards the old reply", async () => {
    const t = setup();
    t.source();
    t.frame();
    t.preview();
    t.frame();
    for (let i = 0; i < 20; i++) {
      t.source();
      t.frame();
    }
    t.preview();
    t.frame();
    expect(t.requests).toHaveLength(1);
    t.requests[0].resolve(1);
    await flush();
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1].pane).toBe("preview");
    t.requests[1].resolve(2);
    await flush();
    expect(t.apply).toHaveBeenCalledExactlyOnceWith("preview", 2);
  });

  it("manual intent invalidates before the next scroll frame", async () => {
    const t = setup();
    t.source();
    t.frame();
    t.sync.intent();
    t.requests[0].resolve(1);
    await flush();
    expect(t.apply).not.toHaveBeenCalled();
  });

  it.each([null, "session:2", "revision:2", "geometry:2", "layout:2"])(
    "never applies a reply after context changes to %s",
    async (context) => {
      const t = setup();
      t.source();
      t.frame();
      t.setContext(context);
      t.requests[0].resolve(1);
      await flush();
      expect(t.apply).not.toHaveBeenCalled();
    },
  );

  it("stops for missing anchors/geometry without percentage fallback or retry", async () => {
    const t = setup();
    t.sync.observe("source", () => null);
    t.frame();
    expect(t.requests).toHaveLength(0);
    t.source();
    t.frame();
    t.requests[0].resolve(null);
    await flush();
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.requests).toHaveLength(1);
  });

  it("cancel does not free the still-running native slot", async () => {
    const t = setup();
    t.source();
    t.frame();
    t.sync.cancel();
    t.source();
    t.frame();
    expect(t.requests).toHaveLength(1);
    t.requests[0].resolve(1);
    await flush();
    expect(t.requests).toHaveLength(2);
    expect(t.apply).not.toHaveBeenCalled();
  });

  it("disposal cancels scheduled reads and running replies", async () => {
    const t = setup();
    t.source();
    t.frame();
    t.preview();
    t.sync.dispose();
    t.frame();
    t.requests[0].resolve(1);
    await flush();
    t.source();
    t.frame();
    expect(t.requests).toHaveLength(1);
    expect(t.apply).not.toHaveBeenCalled();
  });
});
