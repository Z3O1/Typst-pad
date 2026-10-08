import { describe, expect, it, vi } from "vitest";
import { createDocumentDragSelection } from "./document-drag-selection";

const point = (xPt: number) => ({ page: 1, xPt, yPt: 10 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("文档拖动选区", () => {
  it("固定按下位置为 anchor，前后拖动都只改变 head", async () => {
    const apply = vi.fn();
    const resolve = vi.fn(async (p: ReturnType<typeof point>) => p.xPt);
    const drag = createDocumentDragSelection({ resolve, isCurrent: () => true, apply });
    drag.start(point(10));
    drag.move(point(20));
    await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith(10, 20));
    drag.move(point(5));
    await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith(10, 5));
    expect(resolve.mock.calls.map(([p]) => p.xPt)).toEqual([10, 20, 5]);
  });

  it("按下命中在途时合并移动，松开后的最终落点仍会提交", async () => {
    const anchor = deferred<number>();
    const resolve = vi.fn((p: ReturnType<typeof point>) =>
      p.xPt === 10 ? anchor.promise : Promise.resolve(p.xPt),
    );
    const apply = vi.fn();
    const drag = createDocumentDragSelection({ resolve, isCurrent: () => true, apply });
    drag.start(point(10));
    for (let i = 11; i <= 30; i++) drag.move(point(i));
    expect(resolve).toHaveBeenCalledTimes(1);
    anchor.resolve(10);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(10, 30));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("head 查询期间的新落点不会被旧结果覆盖", async () => {
    const oldHead = deferred<number>();
    const resolve = vi.fn((p: ReturnType<typeof point>) =>
      p.xPt === 20 ? oldHead.promise : Promise.resolve(p.xPt),
    );
    const apply = vi.fn();
    const drag = createDocumentDragSelection({ resolve, isCurrent: () => true, apply });
    drag.start(point(10));
    drag.move(point(20));
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    drag.move(point(30));
    drag.move(point(40));
    oldHead.resolve(20);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(10, 40));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls.map(([p]) => p.xPt)).toEqual([10, 20, 40]);
  });

  it.each(["cancel", "stale"])("%s 后拒绝在途命中", async (reason) => {
    const head = deferred<number>();
    let current = true;
    const resolve = vi.fn((p: ReturnType<typeof point>) =>
      p.xPt === 20 ? head.promise : Promise.resolve(p.xPt),
    );
    const apply = vi.fn();
    const drag = createDocumentDragSelection({ resolve, isCurrent: () => current, apply });
    drag.start(point(10));
    drag.move(point(20));
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    if (reason === "cancel") drag.cancel();
    else current = false;
    head.resolve(20);
    await head.promise;
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
  });

  it("新手势不受旧 anchor 的迟到结果和 finally 影响", async () => {
    const oldAnchor = deferred<number>();
    const resolve = vi.fn((p: ReturnType<typeof point>) =>
      p.xPt === 10 ? oldAnchor.promise : Promise.resolve(p.xPt),
    );
    const apply = vi.fn();
    const drag = createDocumentDragSelection({ resolve, isCurrent: () => true, apply });
    drag.start(point(10));
    drag.move(point(20));
    drag.start(point(30));
    drag.move(point(40));
    await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith(30, 40));
    oldAnchor.resolve(10);
    await oldAnchor.promise;
    drag.move(point(50));
    await vi.waitFor(() => expect(apply).toHaveBeenLastCalledWith(30, 50));
    expect(apply.mock.calls).toEqual([
      [30, 40],
      [30, 50],
    ]);
  });

  it("没有可用主文档 anchor 时不制造选区", async () => {
    const resolve = vi.fn(async () => null);
    const apply = vi.fn();
    const drag = createDocumentDragSelection({ resolve, isCurrent: () => true, apply });
    drag.start(point(10));
    drag.move(point(20));
    await Promise.resolve();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
