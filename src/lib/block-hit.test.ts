import { describe, it, expect } from "vitest";
import { cropPagePoint, clampHitOffset } from "./block-hit";

/** 一个 371.25pt 宽、高 60pt 的裁剪带，原点在 (58.01, 55.93) */
const crop = {
  page: 1,
  xPt: 58.01,
  yPt: 55.93,
  widthPt: 371.25,
  heightPt: 60,
  from: 0,
  to: 10,
};

describe("cropPagePoint：切片上的点 → 页面坐标（pt）", () => {
  it("左上角 → 带的原点", () => {
    const p = cropPagePoint({ left: 200, top: 100, width: 495, height: 80 }, { x: 200, y: 100 }, crop);
    expect(p).toEqual({ page: 1, xPt: 58.01, yPt: 55.93 });
  });

  it("右下角 → 带的右下角（换算只依赖 DOM 实测矩形，与缩放比例无关）", () => {
    const p = cropPagePoint({ left: 200, top: 100, width: 495, height: 80 }, { x: 695, y: 180 }, crop);
    expect(p!.xPt).toBeCloseTo(58.01 + 371.25, 6);
    expect(p!.yPt).toBeCloseTo(55.93 + 60, 6);
  });

  it("中点 → 带的中点", () => {
    const p = cropPagePoint(
      { left: 0, top: 0, width: 400, height: 200 },
      { x: 200, y: 100 },
      { ...crop, xPt: 0, yPt: 0 },
    );
    expect(p!.xPt).toBeCloseTo(371.25 / 2, 6);
    expect(p!.yPt).toBeCloseTo(30, 6);
  });

  it("缩放变化不影响结果：同一相对位置 → 同一页面坐标", () => {
    // 同一块在两种显示宽度下（例如界面缩放 100% / 150%）
    const a = cropPagePoint({ left: 0, top: 0, width: 500, height: 80 }, { x: 250, y: 40 }, crop);
    const b = cropPagePoint({ left: 30, top: 10, width: 750, height: 120 }, { x: 405, y: 70 }, crop);
    expect(b!.xPt).toBeCloseTo(a!.xPt, 6);
    expect(b!.yPt).toBeCloseTo(a!.yPt, 6);
  });

  it("点在矩形外（拖动越界）→ 夹回边界", () => {
    const rect = { left: 100, top: 50, width: 400, height: 100 };
    expect(cropPagePoint(rect, { x: -500, y: -500 }, crop)!.xPt).toBeCloseTo(58.01, 6);
    expect(cropPagePoint(rect, { x: -500, y: -500 }, crop)!.yPt).toBeCloseTo(55.93, 6);
    expect(cropPagePoint(rect, { x: 9999, y: 9999 }, crop)!.xPt).toBeCloseTo(58.01 + 371.25, 6);
  });

  it("退化情形返回 null：矩形无面积 / 带尺寸非正 / 坐标非法", () => {
    const rect = { left: 0, top: 0, width: 400, height: 100 };
    expect(cropPagePoint({ ...rect, height: 0 }, { x: 10, y: 10 }, crop)).toBeNull();
    expect(cropPagePoint(rect, { x: 10, y: 10 }, { ...crop, heightPt: 0 })).toBeNull();
    expect(cropPagePoint(rect, { x: NaN, y: 10 }, crop)).toBeNull();
    expect(cropPagePoint(rect, { x: 10, y: Infinity }, crop)).toBeNull();
  });

  it("page 跟着块走（多页文档里命中测试只在该页找）", () => {
    const p = cropPagePoint({ left: 0, top: 0, width: 10, height: 10 }, { x: 0, y: 0 }, {
      ...crop,
      page: 3,
    });
    expect(p!.page).toBe(3);
  });
});

describe("clampHitOffset：命中结果钳回块内（字节偏移）", () => {
  it("块内原样返回", () => {
    expect(clampHitOffset(12, { fromByte: 0, toByte: 20 })).toBe(12);
  });

  it("越界钳到两端", () => {
    expect(clampHitOffset(-5, { fromByte: 10, toByte: 20 })).toBe(10);
    expect(clampHitOffset(999, { fromByte: 10, toByte: 20 })).toBe(20);
  });

  it("null / 非有限数 → null（调用方退回块首）", () => {
    expect(clampHitOffset(null, { fromByte: 0, toByte: 20 })).toBeNull();
    expect(clampHitOffset(undefined, { fromByte: 0, toByte: 20 })).toBeNull();
    expect(clampHitOffset(NaN, { fromByte: 0, toByte: 20 })).toBeNull();
    // 跨 IPC 回来可能是字符串（防御性：当非法处理，绝不返回 NaN 位置）
    expect(clampHitOffset("12" as unknown as number, { fromByte: 0, toByte: 20 })).toBeNull();
  });

  it("小数偏移取整（Rust 侧给的是整数，这里只是兜底）", () => {
    expect(clampHitOffset(12.6, { fromByte: 0, toByte: 20 })).toBe(13);
  });
});
