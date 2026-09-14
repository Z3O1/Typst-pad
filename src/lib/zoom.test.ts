// zoom 单元测试：Ctrl+滚轮界面缩放的纯逻辑（方向 / 档距 / 收敛 / 浮点圆整）。
import { describe, it, expect } from "vitest";
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  nextZoom,
  wheelZoomSteps,
  zoomIn,
  zoomLabel,
  zoomOut,
  zoomPercent,
  zoomFromWidths,
  zoomApplied,
  zoomProbeVerdict,
  zoomRejectedNotice,
} from "./zoom";

describe("clampZoom", () => {
  it("界内原样返回，并圆整到一档（消掉浮点毛刺）", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1.2)).toBe(1.2);
    expect(clampZoom(1.2000000000000002)).toBe(1.2);
    expect(clampZoom(0.5)).toBe(ZOOM_MIN);
    expect(clampZoom(2.5)).toBe(ZOOM_MAX);
  });

  it("超界收敛到上下限", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(-2)).toBe(ZOOM_MIN);
  });

  it("非法值回落 100%", () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(null)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(undefined)).toBe(ZOOM_DEFAULT);
  });

  it("圆整到最近的档（0.1 的倍数）", () => {
    expect(clampZoom(1.14)).toBe(1.1);
    expect(clampZoom(1.16)).toBe(1.2);
  });
});

describe("wheelZoomSteps", () => {
  it("滚轮向上 = 放大（正档），向下 = 缩小", () => {
    expect(wheelZoomSteps(-100)).toBe(1);
    expect(wheelZoomSteps(100)).toBe(-1);
  });

  it("纵向位移为 0 时退回横向（Shift 滚轮被浏览器转成横向的真机形态）", () => {
    expect(wheelZoomSteps(0, -100)).toBe(1);
    expect(wheelZoomSteps(0, 100)).toBe(-1);
  });

  it("两者都有时纵向优先；都没有则 0 档（不动）", () => {
    expect(wheelZoomSteps(-100, 100)).toBe(1);
    expect(wheelZoomSteps(0, 0)).toBe(0);
    expect(wheelZoomSteps(Number.NaN, Number.NaN)).toBe(0);
  });

  it("触摸板的小 delta 不会一划到尾（下限 0.2 档）", () => {
    expect(wheelZoomSteps(-4)).toBeCloseTo(0.2, 6);
  });

  it("大 delta / 页模式最多 3 档", () => {
    expect(wheelZoomSteps(-1000)).toBe(3);
    expect(wheelZoomSteps(-1, 0, 2)).toBe(3);
  });

  it("行模式（deltaMode = 1）一格算一档", () => {
    expect(wheelZoomSteps(-1, 0, 1)).toBe(1);
    expect(wheelZoomSteps(-3, 0, 1)).toBe(3);
  });
});

describe("nextZoom / zoomIn / zoomOut", () => {
  it("向上滚 5 格：100% → 150%", () => {
    let z = ZOOM_DEFAULT;
    for (let i = 0; i < 5; i++) z = nextZoom(z, -100);
    expect(z).toBe(1.5);
    expect(zoomLabel(z)).toBe("150%");
  });

  it("累加不产生浮点毛刺", () => {
    let z = ZOOM_DEFAULT;
    for (let i = 0; i < 7; i++) z = nextZoom(z, -100);
    expect(z).toBe(1.7);
    expect(z.toString()).toBe("1.7");
  });

  it("到上下限后不再变化", () => {
    expect(nextZoom(ZOOM_MAX, -100)).toBe(ZOOM_MAX);
    expect(nextZoom(ZOOM_MIN, 100)).toBe(ZOOM_MIN);
  });

  it("起点非法时按 100% 起算", () => {
    expect(nextZoom(Number.NaN, -100)).toBeCloseTo(ZOOM_DEFAULT + ZOOM_STEP, 6);
    expect(nextZoom(undefined, -100)).toBeCloseTo(ZOOM_DEFAULT + ZOOM_STEP, 6);
  });

  it("deltaY 为 0 且没有横向位移时不动", () => {
    expect(nextZoom(1.3, 0)).toBe(1.3);
  });

  it("菜单用的 zoomIn / zoomOut 按档步进并夹住", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomIn(1, 3)).toBe(1.3);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });
});

describe("zoomPercent / zoomLabel", () => {
  it("取整百分比，越界先收敛", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(1.25)).toBe(130); // 1.25 圆整到 1.3
    expect(zoomPercent(9)).toBe(250);
    expect(zoomLabel(Number.NaN)).toBe("100%");
  });
});

// ---------------------------------------------------------------------------
// 「引擎接受了多少」用 CSS 视口宽度反推（真机上 dpr 判据不可靠，见 zoom.ts 的注解）：
// 引擎实际接受的缩放 = 100% 时的布局宽度 ÷ 当前布局宽度
// ---------------------------------------------------------------------------
describe("zoomFromWidths（布局宽度 → 引擎接受的缩放）", () => {
  it("100%：宽度不变 → 1", () => {
    expect(zoomFromWidths(1200, 1200)).toBeCloseTo(1, 6);
  });

  it("引擎接受了 150%：宽度缩到 800 → 反推 1.5", () => {
    expect(zoomFromWidths(1200, 800)).toBeCloseTo(1.5, 6);
  });

  it("引擎只给到 210%（拒绝了 220%）：反推值就是引擎给的档位", () => {
    expect(zoomFromWidths(1200, 1200 / 2.1)).toBeCloseTo(2.1, 6);
  });

  it("非法输入（0 / 负数 / NaN）→ null（本次不判定）", () => {
    expect(zoomFromWidths(0, 800)).toBeNull();
    expect(zoomFromWidths(1200, 0)).toBeNull();
    expect(zoomFromWidths(Number.NaN, 800)).toBeNull();
    expect(zoomFromWidths(1200, Number.NaN)).toBeNull();
  });
});

describe("zoomApplied（引擎接受的档位是不是请求值）", () => {
  it("一致（2% 容差内，覆盖浮点与测量噪声）→ true", () => {
    expect(zoomApplied(1.5, 1.5)).toBe(true);
    expect(zoomApplied(1.5, 1.51)).toBe(true);
    expect(zoomApplied(1.5, 1.49)).toBe(true);
  });

  it("差一档（10%）或更多 → false（引擎没接受）", () => {
    expect(zoomApplied(1.5, 1.4)).toBe(false);
    expect(zoomApplied(2.2, 2.1)).toBe(false);
  });

  it("量不到（null）→ false（调用方据此不改状态）", () => {
    expect(zoomApplied(1.5, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 一次读数该怎么处理（复核要不要继续等）：accepted / capped / retry / unknown
// ---------------------------------------------------------------------------
describe("zoomProbeVerdict（这次读数要不要再等）", () => {
  it("读到请求值 → accepted", () => {
    expect(zoomProbeVerdict(1.1, 1.1, 1)).toBe("accepted");
    expect(zoomProbeVerdict(1.1, 1.105, 1)).toBe("accepted");
  });

  it("引擎给了别的档位（典型是自己的上限）→ capped（等下去也没用）", () => {
    expect(zoomProbeVerdict(2.2, 2.1, 1)).toBe("capped");
    expect(zoomProbeVerdict(1.5, 1.2, 1)).toBe("capped");
  });

  it("读数与改档前一样 → retry（可能只是还没生效）", () => {
    expect(zoomProbeVerdict(1.5, 1, 1)).toBe("retry");
    expect(zoomProbeVerdict(1.5, 1.01, 1)).toBe("retry");
  });

  it("量不到 → unknown（不改状态、也不谈判定）", () => {
    expect(zoomProbeVerdict(1.5, null, 1)).toBe("unknown");
    expect(zoomProbeVerdict(1.5, Number.NaN, 1)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 「未生效」文案：必须能被用户截图读出成因（量了几次 / 宽度变没变 / dpr）
// ---------------------------------------------------------------------------
describe("zoomRejectedNotice（状态栏文案）", () => {
  it("宽度没变 → 明说没变（=引擎压根没动），带上次数与 dpr", () => {
    const s = zoomRejectedNotice(1.5, 1, 4, { baseline: 1379, current: 1379.4 }, 1.5);
    expect(s).toContain("界面缩放未生效");
    expect(s).toContain("限制在 100%");
    expect(s).toContain("量了 4 次");
    expect(s).toContain("布局宽度没变（1379px）");
    expect(s).toContain("dpr 1.50");
  });

  it("宽度变了 → 写出前后值（=引擎动过又回去）", () => {
    const s = zoomRejectedNotice(1.5, 1, 3, { baseline: 1379, current: 919 }, 1.5);
    expect(s).toContain("布局宽度 1379→919px");
  });

  it("dpr 读不到时不写这一段（别写 NaN）", () => {
    const s = zoomRejectedNotice(2.2, 2.1, 1, { baseline: 1200, current: 545 }, Number.NaN);
    expect(s).toContain("限制在 210%");
    expect(s).not.toContain("dpr");
  });
});
