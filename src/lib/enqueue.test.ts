// 编译引擎 enqueue 互斥逻辑单元测试
import { describe, it, expect } from "vitest";
import { enqueue } from "./typst-engine";

describe("enqueue", () => {
  it("串行执行任务（后一个在前一个完成后才开始）", async () => {
    const order: number[] = [];
    const p1 = enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const p2 = enqueue(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("任务失败不阻断后续任务", async () => {
    const order: string[] = [];
    const failing = enqueue(async () => {
      throw new Error("boom");
    });
    const next = enqueue(async () => {
      order.push("next");
      return 42;
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe(42);
    expect(order).toEqual(["next"]);
  });

  it("返回各任务自身结果", async () => {
    const r1 = enqueue(async () => 1);
    const r2 = enqueue(async () => "two");
    expect(await r1).toBe(1);
    expect(await r2).toBe("two");
  });
});
