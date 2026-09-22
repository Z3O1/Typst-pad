import { describe, it, expect } from "vitest";
import { anchorEffectAt, anchorYMargin, measureAnchorYMargin } from "./scroll-anchor";

describe("anchorYMargin：把光标钉在鼠标那个屏幕高度", () => {
  it("行盒中心对齐：滚动容器顶部 100、点击在 y=300、行高 30 → 余量 = 300-100-15", () => {
    expect(anchorYMargin(300, 100, 1000, 30, "center")).toBe(185);
  });

  it("顶部对齐：不减半行高", () => {
    expect(anchorYMargin(300, 100, 1000, 30, "top")).toBe(200);
  });

  it("点在滚动容器上方（客户区之外）→ 夹到 0", () => {
    expect(anchorYMargin(80, 100, 1000, 30, "center")).toBe(0);
  });

  it("点在滚动容器下方 → 夹到视口高 - 1", () => {
    expect(anchorYMargin(5000, 100, 1000, 30, "center")).toBe(999);
  });

  it("视口高不可测（0 / NaN）→ 只夹下界", () => {
    expect(anchorYMargin(300, 100, 0, 30)).toBe(0);
    expect(anchorYMargin(300, 100, NaN, 30)).toBe(0);
  });

  it("坐标非法 → 0（最保守：顶到最上面）", () => {
    expect(anchorYMargin(NaN, 100, 1000, 30)).toBe(0);
    expect(anchorYMargin(300, NaN, 1000, 30)).toBe(0);
    expect(anchorYMargin(Infinity, 100, 1000, 30)).toBe(0);
  });

  it("行高不可测时按顶部对齐处理（不产出 NaN）", () => {
    expect(anchorYMargin(300, 100, 1000, NaN, "center")).toBe(200);
  });
});

// `measureAnchorYMargin` / `anchorEffectAt` 是把"读布局"与"写事务"分开之后的两半：
// 前者只在 CodeMirror 的 read 阶段跑（可以读 rect），后者只在 write 阶段派发（不再读 rect）。
// 模式切换恢复光标就靠这两半（见 Editor.svelte 的 restoreCaretAnchor）。
describe("measureAnchorYMargin / anchorEffectAt：读布局与写事务分开后的两半", () => {
  type View = Parameters<typeof measureAnchorYMargin>[0];
  const fakeView = (top: number, height: number, lineHeight = 30): View =>
    ({
      scrollDOM: { getBoundingClientRect: () => ({ top, height }) },
      defaultLineHeight: lineHeight,
    }) as unknown as View;

  it("按已保存的视口偏移算 yMargin：行盒顶部落在距滚动容器顶 150px 处", () => {
    expect(measureAnchorYMargin(fakeView(100, 1000), 100 + 150, "top")).toBe(150);
  });

  it("偏移越界 → 夹到 [0, 视口高 - 1]", () => {
    expect(measureAnchorYMargin(fakeView(100, 500), 100 + 900, "top")).toBe(499);
    expect(measureAnchorYMargin(fakeView(100, 500), 100 - 50, "top")).toBe(0);
  });

  it("拿不到滚动容器（视图已拆 / 未挂载）→ null，调用方照常只落选区", () => {
    const broken = {
      scrollDOM: {
        getBoundingClientRect: () => {
          throw new Error("view destroyed");
        },
      },
      defaultLineHeight: 30,
    } as unknown as View;
    expect(measureAnchorYMargin(broken, 200)).toBeNull();
  });

  it("anchorEffectAt 用现成的 yMargin 构造滚动目标（write 阶段不该再读布局）", () => {
    const effect = anchorEffectAt(5, 120);
    // StateEffect 的契约：能被 effect.is 认出来（CM 内部靠它匹配）
    expect(typeof (effect as { is?: unknown }).is).toBe("function");
  });
});
