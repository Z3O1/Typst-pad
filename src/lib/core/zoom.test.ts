// zoom 单元测试：Ctrl+滚轮界面缩放的纯逻辑（方向 / 档距 / 收敛 / 浮点圆整）。
import { describe, it, expect } from "vitest";
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_SETTLE_MAX_MS,
  ZOOM_STEP,
  clampZoom,
  accumulateWheelSteps,
  createWheelAccumulator,
  resetWheelAccumulator,
  wheelPendingNotice,
  shouldRebaselineZoom,
  wheelZoomSteps,
  zoomIn,
  zoomLabel,
  zoomOut,
  zoomPercent,
  zoomFromWidths,
  zoomApplied,
  zoomUnobservedNotice,
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

  it("触摸板的小 delta 不会一划到尾（下限 0.1 档，而且要由累加器攒起来）", () => {
    expect(wheelZoomSteps(-4)).toBeCloseTo(0.1, 6);
    expect(wheelZoomSteps(-40)).toBeCloseTo(0.4, 6);
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

// ---------------------------------------------------------------------------
// 滚轮余量累加器（2026-09-16 修的死区，见 zoom.ts 的注解）
//
// 用户反馈「Ctrl+滚轮常态是可以的，但是到上限不知道为什么就不可以了」，状态栏写着
// 「缩放已是 250%（到边界了）」。真因：位移不足一档时（高倍缩放下每格位移会变小），
// 4% 的位移被档位圆整抹掉，而每个事件独立计算 ⇒ 那种滚轮**永远**动不了。
// 下面这几条就是那次反馈的回归网：**不足一档要攒着，攒够了就走一档**。
// ---------------------------------------------------------------------------
describe("accumulateWheelSteps（不足一档的位移要攒起来）", () => {
  it("一整格（100px）照旧是一次一档、不留余量（老手感不许变）", () => {
    const acc = createWheelAccumulator();
    expect(accumulateWheelSteps(acc, -100)).toBe(1);
    expect(acc.remainder).toBe(0);
    expect(accumulateWheelSteps(acc, 100)).toBe(-1);
  });

  it("40px 一格：第一次不动（攒着），第二次走一档", () => {
    const acc = createWheelAccumulator();
    expect(accumulateWheelSteps(acc, -40)).toBe(0);
    expect(acc.remainder).toBeCloseTo(0.4, 6);
    expect(accumulateWheelSteps(acc, -40)).toBe(1);
    expect(acc.remainder).toBeCloseTo(-0.2, 6);
  });

  it("4px 的触摸板小步长也能攒够一档（老代码里这是死区）", () => {
    const acc = createWheelAccumulator();
    const steps = [0, 1, 2, 3, 4].map(() => accumulateWheelSteps(acc, -4));
    expect(steps.reduce((a, b) => a + b, 0)).toBe(1); // 五下 = 一档（4px × 5 = 20px，取下限）
  });

  it("一次大位移照旧最多 3 档", () => {
    const acc = createWheelAccumulator();
    expect(accumulateWheelSteps(acc, -1000)).toBe(3);
  });

  it("反向滚动丢掉余量（不然「滚一半再反滚」会被余量抵消，手感发黏）", () => {
    const acc = createWheelAccumulator();
    accumulateWheelSteps(acc, -40); // 攒下 0.4 档
    expect(accumulateWheelSteps(acc, 100)).toBe(-1); // 直接缩一档，不是 -0.6
    expect(acc.remainder).toBeCloseTo(0, 6);
  });

  it("余量不会攒成一大笔存款（圆整后必然落在 ±0.5 档以内）", () => {
    const acc = createWheelAccumulator();
    for (let i = 0; i < 20; i++) accumulateWheelSteps(acc, -40);
    expect(Math.abs(acc.remainder)).toBeLessThanOrEqual(0.5);
  });

  it("resetWheelAccumulator 清账（键盘/菜单调档后调用）", () => {
    const acc = createWheelAccumulator();
    accumulateWheelSteps(acc, -40);
    resetWheelAccumulator(acc);
    expect(acc.remainder).toBe(0);
  });

  it("位移不足一档时把「攒了多少」说出来（否则与「事件没到页面」没法区分）", () => {
    const acc = createWheelAccumulator();
    accumulateWheelSteps(acc, -40);
    expect(wheelPendingNotice(acc)).toContain("攒到 40%");
    accumulateWheelSteps(acc, -40); // 走掉一档后余量翻成 -0.2
    expect(wheelPendingNotice(acc)).toContain("攒到 20%");
  });

  it("**回归**：在 250% 上限处，40px 的滚轮两格就能缩回 240%（用户报的「到上限就不行」）", () => {
    const acc = createWheelAccumulator();
    let z: number = ZOOM_MAX;
    for (let i = 0; i < 2; i++) {
      const steps = accumulateWheelSteps(acc, 40);
      if (steps !== 0) z = clampZoom(z + steps * ZOOM_STEP);
    }
    expect(z).toBe(2.4);
  });
});

describe("zoomIn / zoomOut（菜单与滚轮路径共用）", () => {
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
// 「未生效」文案：必须能被用户截图读出成因（量了几次 / 宽度变没变 / dpr）
// ---------------------------------------------------------------------------
describe("zoomUnobservedNotice（状态栏文案：只说明「没观察到」，不改任何状态）", () => {
  it("宽度没变 → 明说没变（=引擎压根没动），带上次数与 dpr", () => {
    const s = zoomUnobservedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379.4 },
      dpr: 1.5,
    });
    expect(s).toContain("已按你的操作设到 150%");
    expect(s).toContain("引擎侧没观察到变化");
    expect(s).toContain("量了 4 次");
    expect(s).toContain("布局宽度没变（1379px）");
    expect(s).toContain("dpr 1.50");
  });

  it("宽度变了 → 写出前后值（=引擎动过又回去）", () => {
    const s = zoomUnobservedNotice(1.5, 1, {
      measurements: 3,
      widths: { baseline: 1379, current: 919 },
      dpr: 1.5,
    });
    expect(s).toContain("布局宽度 1379→919px");
  });

  it("带上 dpr 判据的交叉验证（宽度说 1.00、dpr 说 1.50 → 我们自己量歪了）", () => {
    const s = zoomUnobservedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
      dpr: 1.5,
      dprFactor: 1.5,
    });
    expect(s).toContain("布局宽度没变（1379px）");
    expect(s).toContain("dpr 判据给 150%");
  });

  it("dpr 判据也读不到时就不写那一段", () => {
    const s = zoomUnobservedNotice(1.5, 1, {
      measurements: 2,
      widths: { baseline: 1379, current: 1379 },
      dprFactor: Number.NaN,
    });
    expect(s).not.toContain("dpr 判据");
  });

  it("dpr 读不到时不写这一段（别写 NaN）", () => {
    const s = zoomUnobservedNotice(2.2, 2.1, {
      measurements: 1,
      widths: { baseline: 1200, current: 545 },
      dpr: Number.NaN,
    });
    expect(s).toContain("已按你的操作设到 220%");
    expect(s).not.toContain("dpr");
  });

  it("滚轮事件次数为 0 → 明说「本会话没收到 Ctrl+滚轮」（事件没到页面，另一个成因）", () => {
    const s = zoomUnobservedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
      wheelEvents: 0,
    });
    expect(s).toContain("本会话没收到 Ctrl+滚轮");
    // 只用键盘/菜单时本来就没有滚轮事件，别让这句话把人误导向"事件被吃掉"
    expect(s).toContain("只用过键盘/菜单时属正常");
  });

  it("滚轮事件有次数 → 写出次数（事件到了，是 setZoom 没生效）", () => {
    const s = zoomUnobservedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
      wheelEvents: 7,
    });
    expect(s).toContain("收到 Ctrl+滚轮 7 次");
  });

  it("没给滚轮次数（旧调用方）→ 那段不写，文案其余部分不变", () => {
    const s = zoomUnobservedNotice(1.5, 1, {
      measurements: 4,
      widths: { baseline: 1379, current: 1379 },
    });
    expect(s).not.toContain("滚轮");
    expect(s).toContain("量了 4 次");
  });
});

describe("shouldRebaselineZoom（这次 resize 要不要重校 100% 基准）", () => {
  it("沉降窗口内 → 不校（缩放自己引发的 resize；一校就把基准压低成新宽度）", () => {
    expect(shouldRebaselineZoom({ now: 1000, settlingUntil: 3000, verifyInFlight: false })).toBe(
      false,
    );
    // 窗口刚过（now == settlingUntil）就算结束
    expect(shouldRebaselineZoom({ now: 3000, settlingUntil: 3000, verifyInFlight: false })).toBe(
      true,
    );
  });

  it("复核在跑 → 一律不校（测量期间任何重校都会带偏读数）", () => {
    expect(shouldRebaselineZoom({ now: 9000, settlingUntil: 0, verifyInFlight: true })).toBe(false);
    expect(shouldRebaselineZoom({ now: 9000, settlingUntil: 8000, verifyInFlight: true })).toBe(
      false,
    );
  });

  it("窗口外、也没复核在跑 → 该校（用户拖窗口就是这条路径）", () => {
    expect(shouldRebaselineZoom({ now: 5000, settlingUntil: 3000, verifyInFlight: false })).toBe(
      true,
    );
    expect(shouldRebaselineZoom({ now: 5000, settlingUntil: 0, verifyInFlight: false })).toBe(true);
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
