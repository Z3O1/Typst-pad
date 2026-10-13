import type { DocumentPoint } from "./document-drag-selection";

export interface SourceScrollAnchor {
  pos: number;
  /** Actual visual row top, as a fraction of the viewport height (not document progress). */
  viewportRatio: number;
}
export interface PreviewScrollAnchor {
  point: DocumentPoint;
  viewportRatio: number;
}
export type ScrollPane = "source" | "preview";

/** One shared async slot for both directions; newer user intent always wins. */
export function createSourceScrollSync<Target>(hooks: {
  context: () => string | null;
  frame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  resolve: (
    pane: ScrollPane,
    anchor: SourceScrollAnchor | PreviewScrollAnchor,
  ) => Promise<Target | null>;
  apply: (pane: ScrollPane, target: Target) => void;
}) {
  let generation = 0;
  let frame = 0;
  let running = false;
  let disposed = false;
  let pending: {
    pane: ScrollPane;
    anchor: SourceScrollAnchor | PreviewScrollAnchor;
    context: string;
    generation: number;
  } | null = null;

  function cancel(): void {
    generation++;
    pending = null;
    if (frame) hooks.cancelFrame(frame);
    frame = 0;
  }

  async function pump(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try {
      while (pending && !disposed) {
        const job = pending;
        pending = null;
        if (job.context !== hooks.context()) continue;
        let target: Target | null = null;
        try {
          target = await hooks.resolve(job.pane, job.anchor);
        } catch {
          // Missing/evicted geometry and failed IPC never justify guessed document progress.
        }
        if (
          target !== null &&
          !disposed &&
          job.generation === generation &&
          job.context === hooks.context()
        )
          hooks.apply(job.pane, target);
      }
    } finally {
      running = false;
    }
  }

  return {
    cancel,
    /** Invalidate an in-flight reply immediately, before the next native scroll event. */
    intent: cancel,
    observe(pane: ScrollPane, read: () => SourceScrollAnchor | PreviewScrollAnchor | null): void {
      cancel();
      const context = hooks.context();
      if (!context || disposed) return;
      const epoch = generation;
      frame = hooks.frame(() => {
        frame = 0;
        if (disposed || epoch !== generation || context !== hooks.context()) return;
        const anchor = read();
        if (!anchor) return;
        pending = { pane, anchor, context, generation: epoch };
        void pump();
      });
    },
    dispose(): void {
      disposed = true;
      cancel();
    },
  };
}
