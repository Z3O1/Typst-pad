// 拖动只改变选区；一个在途命中加一个最新落点，避免每帧向原生后端排队。
export interface DocumentPoint {
  page: number;
  xPt: number;
  yPt: number;
}

export function createDocumentDragSelection<Hit>(hooks: {
  resolve: (point: DocumentPoint) => Promise<Hit | null>;
  isCurrent: () => boolean;
  apply: (anchor: Hit, head: Hit) => void;
}) {
  let generation = 0;
  let pending: DocumentPoint | null = null;
  let running = false;
  let anchor: Promise<Hit | null> | null = null;

  function cancel(): void {
    generation++;
    pending = null;
    anchor = null;
    running = false;
  }

  async function pump(epoch: number): Promise<void> {
    if (running || !anchor) return;
    running = true;
    try {
      const start = await anchor;
      if (!start) return;
      while (epoch === generation && hooks.isCurrent() && pending) {
        const point = pending;
        pending = null;
        const head = await hooks.resolve(point);
        // 旧落点不闪回；release 提交的最后落点也由同一条队列消费。
        if (epoch !== generation || !hooks.isCurrent()) return;
        if (head && !pending) hooks.apply(start, head);
      }
    } finally {
      if (epoch === generation) running = false;
    }
  }

  return {
    start(point: DocumentPoint): void {
      cancel();
      anchor = hooks.resolve(point);
    },
    move(point: DocumentPoint): void {
      if (!anchor) return;
      pending = point;
      void pump(generation);
    },
    cancel,
  };
}
