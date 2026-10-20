import { describe, expect, it } from "vitest";
import {
  caretScrollDelta,
  projectDocumentCaret,
  createDocumentCaretFeedback,
  caretSourceContext,
  type CaretFallbackReason,
} from "./document-caret";

const caret = { offset: 3, page: 2, xPt: 30, yPt: 50, heightPt: 12 };
const rect = { left: 100, top: -40, width: 400, height: 600 };
const box = { x: 20, y: 30, width: 200, height: 300 };

describe("统一编辑光标反馈", () => {
  const anchor = { left: 120, top: 40, height: 16, rotation: 0 };
  const input = {
    scope: 1,
    active: true,
    composing: false,
    exact: anchor,
    reason: "pending" as CaretFallbackReason,
    viewport: { left: 10, top: 20, width: 300, height: 200 },
  };

  it("优先显示当前真实几何，不创建新的源码偏移", () => {
    expect(createDocumentCaretFeedback().resolve(input)).toEqual({
      scope: 1,
      anchor,
      kind: "exact",
    });
  });

  it.each(["pending", "unmapped", "unavailable"] as const)(
    "%s 从未定位过也有明确的视区内输入反馈",
    (reason) => {
      const result = createDocumentCaretFeedback().resolve({ ...input, exact: null, reason })!;
      expect(result.kind).toBe(reason);
      expect(result.anchor.left).toBeGreaterThan(input.viewport.left);
      expect(result.anchor.top + result.anchor.height).toBeLessThan(
        input.viewport.top + input.viewport.height,
      );
    },
  );

  it("连续编辑、导航、null 和失败都保持已确认的物理起点，不设超时", () => {
    const feedback = createDocumentCaretFeedback();
    feedback.resolve(input);
    for (let round = 0; round < 100; round++) {
      for (const reason of ["pending", "unmapped", "unavailable"] as const) {
        const result = feedback.resolve({ ...input, exact: null, reason })!;
        expect(result.anchor).toBe(anchor);
        expect(result.kind).toBe(reason);
        expect(result).not.toHaveProperty("expiresAt");
      }
    }
    const next = { ...anchor, left: 180 };
    expect(feedback.resolve({ ...input, exact: next })).toEqual({
      scope: 1,
      anchor: next,
      kind: "exact",
    });
  });

  it("失焦、非空选区和离开文档模式统一停用，回来不能复用先前的物理起点", () => {
    const feedback = createDocumentCaretFeedback();
    feedback.resolve(input);
    expect(feedback.resolve({ ...input, active: false })).toBeNull();
    const returned = feedback.resolve({ ...input, exact: null })!;
    expect(returned.kind).toBe("pending");
    expect(returned.anchor).not.toEqual(anchor);
  });

  it("新会话不能借用旧文档的输入位置，即使仍聚焦且首编译失败", () => {
    const feedback = createDocumentCaretFeedback();
    feedback.resolve(input);
    const next = feedback.resolve({ ...input, scope: 2, exact: null, reason: "unavailable" })!;
    expect(next.scope).toBe(2);
    expect(next.kind).toBe("unavailable");
    expect(next.anchor).not.toEqual(anchor);
  });

  it("合成冻结最后可见物理起点，不受新源码或迟到几何影响，结束后采用当前精确位置", () => {
    const feedback = createDocumentCaretFeedback();
    feedback.resolve(input);
    const changed = { ...anchor, left: 180 };
    expect(feedback.resolve({ ...input, composing: true, exact: null })?.anchor).toBe(anchor);
    expect(feedback.resolve({ ...input, composing: true, exact: changed })?.anchor).toBe(anchor);
    expect(feedback.resolve({ ...input, exact: changed })?.anchor).toBe(changed);
  });

  it("合成前没有几何也不会消失；取消合成后仍有常规反馈", () => {
    const feedback = createDocumentCaretFeedback();
    const composing = feedback.resolve({ ...input, composing: true, exact: null })!;
    expect(composing.kind).toBe("composing");
    expect(feedback.resolve({ ...input, exact: null })?.anchor).toBe(composing.anchor);
  });

  it("离屏真实位置与滚动/缩窗后的旧锚点只产生已标记的可见兜底，不伪称精确", () => {
    const feedback = createDocumentCaretFeedback();
    const outside = { ...anchor, left: 500, top: 500 };
    expect(feedback.resolve({ ...input, exact: outside })?.kind).toBe("offscreen");
    const viewport = { left: 10, top: 20, width: 45, height: 35 };
    const next = feedback.resolve({ ...input, exact: null, viewport })!;
    expect(next.anchor.left).toBeGreaterThanOrEqual(viewport.left);
    expect(next.anchor.left + 2).toBeLessThanOrEqual(viewport.left + viewport.width);
    expect(next.anchor.top + next.anchor.height).toBeLessThanOrEqual(
      viewport.top + viewport.height,
    );
    expect(feedback.resolve({ ...input, exact: anchor })?.kind).toBe("exact");
  });

  it("无法显示的隐藏/零尺寸视区不产生坏 CSS", () => {
    for (const width of [0, 1, NaN])
      expect(
        createDocumentCaretFeedback().resolve({ ...input, viewport: { ...input.viewport, width } }),
      ).toBeNull();
  });

  it("源码上下文保留真实插入点、空行和 Unicode；长行两侧分别截断", () => {
    expect(caretSourceContext("中文😀abc", 5)).toEqual({ before: "中文😀", after: "abc" });
    expect(caretSourceContext("", 1)).toEqual({ before: "", after: "" });
    expect(caretSourceContext("first\n中文😀abc\nlast", 5, 6, 13)).toEqual({
      before: "中文😀",
      after: "abc",
    });
    expect(caretSourceContext("😀".repeat(50), 51)).toEqual({
      before: "…" + "😀".repeat(20),
      after: "😀".repeat(20) + "…",
    });
  });
});

describe("文档光标投影", () => {
  it("非零 viewBox、滚动和共同缩放都使用同一坐标系", () => {
    expect(projectDocumentCaret(caret, rect, box)).toEqual({
      left: 120,
      top: 0,
      height: 24,
      rotation: 0,
    });
  });

  it.each([-90, 30, 90, 180])("旋转 %s° 后起点及方向不受包围盒影响", (rotationDeg) => {
    const result = projectDocumentCaret({ ...caret, rotationDeg }, rect, box)!;
    expect(result.left).toBe(120);
    expect(result.top).toBe(0);
    expect(result.height).toBeCloseTo(24);
    expect(result.rotation).toBeCloseTo(rotationDeg);
  });

  it("非等比测量先缩放真实方向向量，而非只缩放高度", () => {
    const result = projectDocumentCaret(
      { ...caret, rotationDeg: 30 },
      { ...rect, width: 600 },
      box,
    )!;
    const radians = (result.rotation * Math.PI) / 180;
    expect(-Math.sin(radians) * result.height).toBeCloseTo(-18);
    expect(Math.cos(radians) * result.height).toBeCloseTo(Math.sqrt(3) * 12);
  });

  it("最小可见高度不影响实际插入点", () => {
    expect(projectDocumentCaret({ ...caret, heightPt: 0.1 }, rect, box)).toEqual({
      left: 120,
      top: 0,
      height: 2,
      rotation: 0,
    });
  });

  it("视口内光标不滚动，越界只移动需要的轴", () => {
    const viewport = { left: 10, top: 20, width: 200, height: 300 };
    expect(caretScrollDelta({ left: 100, top: 100, height: 20, rotation: 0 }, viewport)).toEqual({
      x: 0,
      y: 0,
    });
    expect(caretScrollDelta({ left: 250, top: 350, height: 20, rotation: 0 }, viewport)).toEqual({
      x: 64,
      y: 74,
    });
    expect(caretScrollDelta({ left: 0, top: 0, height: 20, rotation: 0 }, viewport)).toEqual({
      x: -34,
      y: -44,
    });
  });

  it("旋转插入线按两端可见范围滚动，超大光标优先显露插入点", () => {
    const viewport = { left: 0, top: 0, width: 100, height: 100 };
    const rotated = caretScrollDelta({ left: 30, top: 50, height: 50, rotation: 90 }, viewport);
    expect(rotated.x).toBeCloseTo(-44);
    expect(rotated.y).toBe(0);
    expect(caretScrollDelta({ left: 50, top: 50, height: 500, rotation: 0 }, viewport)).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      caretScrollDelta(
        { left: 50, top: 50, height: 20, rotation: 0 },
        { ...viewport, width: 0, height: 0 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("无效或隐藏页面不生成可写入 CSS 的坏坐标", () => {
    expect(projectDocumentCaret(caret, { ...rect, width: 0 }, box)).toBeNull();
    expect(projectDocumentCaret(caret, rect, { ...box, height: 0 })).toBeNull();
    expect(projectDocumentCaret({ ...caret, rotationDeg: NaN }, rect, box)).toBeNull();
  });
});
