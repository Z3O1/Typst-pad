// zoom 单元测试：Ctrl+滚轮界面缩放的纯逻辑（方向 / 档距 / 收敛 / 浮点圆整）。
import { describe, it, expect } from "vitest";
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_SETTLE_MAX_MS,
  ZOOM_STEP,
  clampZoom,
  nextZoom,
  shouldRebaselineZoom,
  wheelZoomSteps,
  zoomIn,
  zoomLabel,
  zoomOut,
  zoomPercent,
  zoomFromWidths,
  zoomApplied,
  zoomProbeVerdict,
  zoomAcceptedByTwoJudges,
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
// 双重判据（2026-09-16，用户第六轮反馈「改变窗口大小的时候会动缩放；用 Ctrl+滚轮会回退」）：
// 宽度判据与 dpr 判据**任一成立即接受**，避免"把真的生效了的缩放判成失败并弹回原档"。
// ---------------------------------------------------------------------------
describe("zoomAcceptedByTwoJudges（两条判据任一成立即接受）", () => {
  it("宽度判据说到了请求值 → 接受，且标明是宽度判据定的案（正常路径）", () => {
    expect(zoomAcceptedByTwoJudges(1.3, 1.3, 1.0, 1.2)).toEqual({ accepted: true, by: "width" });
  });

  it("宽度判据瞎了（读数与改档前一模一样）而 dpr 判据给请求值 → 接受（那台机器的形状）", () => {
    // 关键回归：修前只认宽度 → 这里会被判成"引擎没动"，档位被拉回 1.2，用户看到"缩放会回退"
    expect(zoomAcceptedByTwoJudges(1.3, 1.2, 1.3, 1.2)).toEqual({ accepted: true, by: "dpr" });
  });

  it("宽度判据压根量不到、dpr 判据给请求值 → 接受（fail-open 到第二条判据）", () => {
    expect(zoomAcceptedByTwoJudges(1.3, null, 1.3, 1.2)).toEqual({ accepted: true, by: "dpr" });
  });

  it("宽度判据读到**别的**档位（引擎上限，如 2.1）→ 不接受，也不让 dpr 判据推翻它", () => {
    // 引擎确实响应了、只是给的档位不同：这时按引擎给的档位收敛才对（capped 路径）
    expect(zoomAcceptedByTwoJudges(2.5, 2.1, 2.5, 2.4)).toEqual({ accepted: false, by: null });
  });

  it("两条都说没动 → 不接受（引擎真没动，缩放死区保护照旧生效）", () => {
    expect(zoomAcceptedByTwoJudges(1.3, 1.2, 1.2, 1.2)).toEqual({ accepted: false, by: null });
    expect(zoomAcceptedByTwoJudges(1.3, 1.2, null, 1.2)).toEqual({ accepted: false, by: null });
  });

  it("dpr 判据给的是另一个档位（不跟随 ZoomFactor 的机器）→ 不接受", () => {
    // 那台机器上 dpr 停在 1.0（显示器缩放下不跟随），宽度也说没动 → 判定"引擎没动"
    expect(zoomAcceptedByTwoJudges(1.3, 1.2, 1.0, 1.2)).toEqual({ accepted: false, by: null });
  });

  it("容差与 zoomApplied 一致（2%）：1.30 请求、1.306 读数仍算接受", () => {
    expect(zoomAcceptedByTwoJudges(1.3, 1.306, null, 1.2).accepted).toBe(true);
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
    const s = zoomRejectedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379.4 },
      dpr: 1.5,
    });
    expect(s).toContain("界面缩放未生效");
    expect(s).toContain("限制在 100%");
    expect(s).toContain("量了 4 次");
    expect(s).toContain("布局宽度没变（1379px）");
    expect(s).toContain("dpr 1.50");
  });

  it("宽度变了 → 写出前后值（=引擎动过又回去）", () => {
    const s = zoomRejectedNotice(1.5, 1, {
      measurements: 3,
      widths: { baseline: 1379, current: 919 },
      dpr: 1.5,
    });
    expect(s).toContain("布局宽度 1379→919px");
  });

  it("带上 dpr 判据的交叉验证（宽度说 1.00、dpr 说 1.50 → 我们自己量歪了）", () => {
    const s = zoomRejectedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
      dpr: 1.5,
      dprFactor: 1.5,
    });
    expect(s).toContain("布局宽度没变（1379px）");
    expect(s).toContain("dpr 判据给 150%");
  });

  it("dpr 判据也读不到时就不写那一段", () => {
    const s = zoomRejectedNotice(1.5, 1, {
      measurements: 2,
      widths: { baseline: 1379, current: 1379 },
      dprFactor: Number.NaN,
    });
    expect(s).not.toContain("dpr 判据");
  });

  it("dpr 读不到时不写这一段（别写 NaN）", () => {
    const s = zoomRejectedNotice(2.2, 2.1, {
      measurements: 1,
      widths: { baseline: 1200, current: 545 },
      dpr: Number.NaN,
    });
    expect(s).toContain("限制在 210%");
    expect(s).not.toContain("dpr");
  });

  it("滚轮事件次数为 0 → 明说「本会话没收到 Ctrl+滚轮」（事件没到页面，另一个成因）", () => {
    const s = zoomRejectedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
      wheelEvents: 0,
    });
    expect(s).toContain("本会话没收到 Ctrl+滚轮");
    // 只用键盘/菜单时本来就没有滚轮事件，别让这句话把人误导向"事件被吃掉"
    expect(s).toContain("只用过键盘/菜单时属正常");
  });

  it("滚轮事件有次数 → 写出次数（事件到了，是 setZoom 没生效）", () => {
    const s = zoomRejectedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
      wheelEvents: 7,
    });
    expect(s).toContain("收到 Ctrl+滚轮 7 次");
  });

  it("没给滚轮次数（旧调用方）→ 那段不写，文案其余部分不变", () => {
    const s = zoomRejectedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
    });
    expect(s).not.toContain("滚轮");
    expect(s).toContain("量了 4 次");
  });
});

describe("shouldRebaselineZoom（这次 resize 要不要重校 100% 基准）", () => {
  it("沉降窗口内 → 不校（缩放自己引发的 resize；一校就把基准压低成新宽度）", () => {
    expect(
      shouldRebaselineZoom({ now: 1000, settlingUntil: 3000, verifyInFlight: false }),
    ).toBe(false);
    // 窗口刚过（now == settlingUntil）就算结束
    expect(
      shouldRebaselineZoom({ now: 3000, settlingUntil: 3000, verifyInFlight: false }),
    ).toBe(true);
  });

  it("复核在跑 → 一律不校（测量期间任何重校都会带偏读数）", () => {
    expect(
      shouldRebaselineZoom({ now: 9000, settlingUntil: 0, verifyInFlight: true }),
    ).toBe(false);
    expect(
      shouldRebaselineZoom({ now: 9000, settlingUntil: 8000, verifyInFlight: true }),
    ).toBe(false);
  });

  it("窗口外、也没复核在跑 → 该校（用户拖窗口就是这条路径）", () => {
    expect(
      shouldRebaselineZoom({ now: 5000, settlingUntil: 3000, verifyInFlight: false }),
    ).toBe(true);
    expect(
      shouldRebaselineZoom({ now: 5000, settlingUntil: 0, verifyInFlight: false }),
    ).toBe(true);
  });

  it("沉降窗口是兜底长度（复核正常 1s 内收尾，窗口给 2s 足够）", () => {
    expect(ZOOM_SETTLE_MAX_MS).toBeGreaterThanOrEqual(1000);
    expect(
      shouldRebaselineZoom({
        now: 1,
        settlingUntil: 1 + ZOOM_SETTLE_MAX_MS - 1,
        verifyInFlight: false,
      }),
    ).toBe(false);
  });
});
