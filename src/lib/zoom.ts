// 界面缩放纯逻辑（**Ctrl+滚轮** 放大/缩小整个界面）。
//
// 为什么是"缩放"而不是"改分栏宽度"：用户的原话是「字太小看不清」——要的是字变大，
// 不是让某一栏变宽。这里给出的是 **webview 缩放系数**（Tauri `setZoom`，等价于浏览器 Ctrl+滚轮
// 缩放）：CSS 像素不变、由引擎等比放大渲染，所以 CodeMirror 的行高测量、SVG 预览的尺寸计算
// 全都继续正确（换 CSS `zoom` 就会让 getBoundingClientRect 与设置值的单位错位，CM6 会算错行高）。
//
// 纯函数放这里以便单测：档距 / 方向 / 上下限收敛 / 浮点圆整 / 数值格式化。

/** 100%：不缩放 */
export const ZOOM_DEFAULT = 1;
/** 下限 50%：再小就没法用了 */
export const ZOOM_MIN = 0.5;
/** 上限 250%：再大基本没有意义（页面也很少用到） */
export const ZOOM_MAX = 2.5;
/** 一档 10%（鼠标滚轮一格 / 菜单点一次） */
export const ZOOM_STEP = 0.1;

/**
 * 「设完缩放再确认一次」的延迟（毫秒）。
 *
 * 起因（2026-09-14 实机反馈「放大根本没用、缩小有用」）：Windows 的 WebView2 在 Ctrl+滚轮
 * 这类缩放手势进行中/结束时，可能用它自己那套逻辑把宿主设的 ZoomFactor 还原回手势开始时的值
 * （WebView2Feedback #1022 记录了这个行为）。所以滚轮事件里立刻 setZoom 有可能被抹掉，
 * 需要在**手势停下来之后**（约 250ms 没有新的滚轮事件）再设一遍。
 * 值没被抹掉时这次调用是空操作，所以代价只是多一次 IPC。
 */
export const ZOOM_CONFIRM_DELAY_MS = 250;

/**
 * 收敛缩放系数：非法值回落 100%，超界收敛到上下限，并**按一档圆整**。
 * 圆整是必需的：0.1 累加会出现 1.2000000000000002 这种值，它会原样写进存档、
 * 也会出现在状态栏文案里（"缩放 120.00000000000001%"）。
 */
export function clampZoom(zoom: number | null | undefined): number {
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return ZOOM_DEFAULT;
  const stepped = Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
  return Number(clamped.toFixed(2));
}

/** 缩放系数 → 整数百分比（状态栏文案 / 菜单标签用） */
export function zoomPercent(zoom: number | null | undefined): number {
  return Math.round(clampZoom(zoom) * 100);
}

/** 缩放系数 → 展示文案（如 "120%"） */
export function zoomLabel(zoom: number | null | undefined): string {
  return `${zoomPercent(zoom)}%`;
}

/**
 * 一次滚轮事件相当于几档（0.2 ~ 3，可带符号：正 = 放大）。
 *
 * 两个真机坑都在这里处理：
 * 1. **位移量要同时看 deltaY 与 deltaX**：按着 Shift 滚轮时 Chromium 把纵向滚动转成横向
 *    （`deltaY = 0`、`deltaX` 有值），只读 deltaY 会"按了没反应"（实测踩过）。
 * 2. **三种 deltaMode 的"一格"差别很大**：像素模式（鼠标一格 ≈ 100）按此折算并在 < 50 时
 *    视为触摸板小步长（下限 0.2 档，否则触摸板一划就窜到顶）；行模式一格算一档；页模式给 3 档。
 */
export function wheelZoomSteps(deltaY: number, deltaX = 0, deltaMode = 0): number {
  const y = Number.isFinite(deltaY) ? deltaY : 0;
  const effective = y !== 0 ? y : Number.isFinite(deltaX) ? deltaX : 0;
  if (effective === 0) return 0;

  const abs = Math.abs(effective);
  let notches: number;
  if (deltaMode === 1) notches = Math.min(3, Math.max(1, abs));
  else if (deltaMode === 2) notches = 3;
  else if (abs >= 50) notches = Math.min(3, Math.max(1, Math.round(abs / 100)));
  else notches = Math.max(0.2, abs / 100);

  // 滚轮向上（deltaY < 0）= 放大
  return (effective < 0 ? 1 : -1) * notches;
}

/** 滚轮 → 新的缩放系数（已收敛、已圆整） */
export function nextZoom(
  current: number | null | undefined,
  deltaY: number,
  deltaX = 0,
  deltaMode = 0,
): number {
  const steps = wheelZoomSteps(deltaY, deltaX, deltaMode);
  return clampZoom(clampZoom(current) + steps * ZOOM_STEP);
}

/** 放大 N 档（菜单项用） */
export function zoomIn(current: number | null | undefined, times = 1): number {
  return clampZoom(clampZoom(current) + times * ZOOM_STEP);
}

/** 缩小 N 档（菜单项用） */
export function zoomOut(current: number | null | undefined, times = 1): number {
  return clampZoom(clampZoom(current) - times * ZOOM_STEP);
}

// ---------------------------------------------------------------------------
// 「引擎到底接受了多少缩放」——用 **CSS 视口宽度** 反推（2026-09-14 用户第三次反馈
// 「缩放到最大后无法从 Ctrl+滚轮缩小」后换的判据）
//
// 旧判据读 `devicePixelRatio`（dpr = 显示器缩放 × 页面缩放）：真机上它可能不跟随宿主设的
// ZoomFactor，于是代码把整个复核关掉（fail-open）—— 复核一关，`uiZoom` 就会一路涨到 250%
// 而引擎其实停在更低的档位，用户往下滚要滚十几档才有反应，看到的正是「最大后无法缩小」。
//
// 页面缩放的定义就是"CSS 视口按比例缩小"（WebView2 的 ZoomFactor 也一样：预览栏 CSS 宽度
// 505 → 331 就是这么来的），所以**宽度比是精确信号**，与显示器缩放、dpr 是否跟随都无关：
//     引擎实际接受的缩放 = 100% 时的布局宽度 ÷ 当前布局宽度
// 基准（100% 时的布局宽度）在启动校准里量一次；每次改档/窗口尺寸变化后按"当前档位 × 当前宽度"
// 再校一遍，所以它既不会被缩放带偏，也不会被用户拖窗口带偏。
// 引擎接受了请求值时它恰好等于请求值；引擎拒绝时它停在引擎给的档位上 —— 前端据此把状态拉回。
// ---------------------------------------------------------------------------

/**
 * 由布局宽度反推引擎实际接受的缩放：`widthAt100` = 100% 时的 CSS 布局宽度。
 * 宽度非法（0 / 负数 / NaN）时给 null＝本次不判定（**绝不拿坏读数去改用户的状态**）。
 */
export function zoomFromWidths(widthAt100: number, currentWidth: number): number | null {
  if (!(widthAt100 > 0) || !(currentWidth > 0)) return null;
  if (!Number.isFinite(widthAt100) || !Number.isFinite(currentWidth)) return null;
  return widthAt100 / currentWidth;
}

/** 引擎接受的档位是否就是请求值（容差 2%，比一档 10% 小得多，够区分"接受/拒绝"） */
export function zoomApplied(target: number, observed: number | null, tolerance = 0.02): boolean {
  if (observed === null || !Number.isFinite(observed)) return false;
  return Math.abs(observed - target) <= tolerance;
}

// ---------------------------------------------------------------------------
// 复核的等待节奏（2026-09-14 用户第四次反馈「缩放会无效」+ 状态栏「引擎把 150% 限制在 100%」）
//
// 那台机器上引擎**完全没接受**放大（缩小有效），而且 0.7.4（那时还没有任何复核）时就是这个
// 现象，所以不像是复核自己误判。真机上没法复现，能做的有两条：
//   ① **多等一会儿再量**：引擎把宿主设的 ZoomFactor 落到布局上可能有延迟（也可能被它自己在
//      手势结束时那套处理抹掉，#1022）；设一次立刻量只覆盖"立即生效"这一种引擎。
//   ② **量不到就再设一遍**：值被丢掉时只有重设才救得回来（立刻重设没用——丢掉发生在之后）。
// 于是复核变成：设一次 → 按 0 / 250 / 700ms 连量三次 → 还不对就把这一档再设一遍再量一次。
// 引擎明确给了**别的**档位（比如上限 210%）时不再等（见 zoomProbeVerdict 的 "capped"）——
// 那种情况等多久都一样，早报早安心。
// ---------------------------------------------------------------------------

/** 复核量读数的时间点（毫秒，相对第一次 setZoom）：0 = 立刻，后两次是给"迟到"的引擎留的时间 */
export const ZOOM_VERIFY_WAITS_MS = [0, 250, 700] as const;
/** 都量不到时最后一次"重设"之前的等待（先让引擎把手势收尾） */
export const ZOOM_VERIFY_RESET_DELAY_MS = 80;
/** 一次 setZoom 之后等一帧 + 这段余量再读布局宽度（引擎要重排完才量得准） */
export const ZOOM_MEASURE_SETTLE_MS = 80;

/** 一次读数的判词（见上方注解） */
export type ZoomProbeVerdict = "accepted" | "capped" | "retry" | "unknown";

/**
 * 这次读数该怎么处理：
 * - `accepted`：引擎给的正是请求值（容差 2%）；
 * - `capped`：引擎给了**别的**档位（与改档前不同）——典型是它自己的上限，等下去也没用；
 * - `retry`：读数和改档前一模一样——可能只是还没生效（或值被同一档位覆盖），值得再等；
 * - `unknown`：量不到（非法宽度）——不改状态，也谈不上判定（见调用方的 fail-open）。
 */
export function zoomProbeVerdict(
  target: number,
  observed: number | null,
  previous: number,
  tolerance = 0.02,
): ZoomProbeVerdict {
  if (observed === null || !Number.isFinite(observed)) return "unknown";
  if (Math.abs(observed - target) <= tolerance) return "accepted";
  if (Math.abs(observed - previous) > tolerance) return "capped";
  return "retry";
}

/**
 * 复核判定"引擎没接受"时的状态栏文案。
 *
 * **把实测数据一起写出来**（2026-09-14 加）：这个现象只在用户那台真机上出现，而我拿不到它的
 * 任何运行时数据（release 版没有 devtools、dbg 只写 console）——用户截图里的状态栏是我们唯一
 * 能读到的通道。所以文案里带上"量了几次 / 布局宽度变了没有 / dpr"，一张截图就能判断是
 * 「引擎把档位丢了」（宽度变过又回来）还是「引擎压根没动」（宽度一模一样，dpr 也不动）。
 */
/** 「未生效」文案要带的实测数据（都是给"下一次截图"用的，见上方注解） */
export interface ZoomRejectDetail {
  /** 复核量了几次读数 */
  measurements: number;
  /** 100% 基准宽度与当时的布局宽度 */
  widths: { baseline: number; current: number };
  /** 当时的 devicePixelRatio */
  dpr?: number;
  /**
   * 用 dpr 反推的引擎档位（第二条独立判据，只作交叉验证）。
   * 宽度判据说 1.00、它说 1.50 → 是我们自己量歪了；两条都说 1.00 → 引擎真没动。
   */
  dprFactor?: number | null;
  /**
   * 本会话页面收到过多少次「带 Ctrl 的滚轮事件」（2026-09-16 加，纯诊断）。
   * **0 次 = 事件压根没到页面**（在到达页面之前就被吃掉了：引擎自己那套缩放控件开着、
   * 鼠标驱动或系统手势先接走）——那种情况怎么改 `setZoom` 都没用；**有次数 = 事件到了，
   * 是 `setZoom` 没生效**。用户反复反馈「缩放调整失败」而我看不到他的机器，这一条让一张截图
   * 就能分清这两类成因。交叉验证靠键盘通道（`Ctrl+Shift+=/-`，不经过任何手势）：
   * 键盘能推、滚轮不能 ⇒ 问题在手势路径；两者都不能 ⇒ 问题在 setZoom 本身。
   */
  wheelEvents?: number;
}

export function zoomRejectedNotice(
  target: number,
  observed: number,
  detail0: ZoomRejectDetail,
): string {
  const detail = [`量了 ${detail0.measurements} 次`];
  const base = Math.round(detail0.widths.baseline);
  const now = Math.round(detail0.widths.current);
  detail.push(base === now ? `布局宽度没变（${now}px）` : `布局宽度 ${base}→${now}px`);
  const dpr = detail0.dpr;
  if (typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0) {
    detail.push(`dpr ${dpr.toFixed(2)}`);
  }
  const dprFactor = detail0.dprFactor;
  if (typeof dprFactor === "number" && Number.isFinite(dprFactor) && dprFactor > 0) {
    detail.push(`dpr 判据给 ${zoomLabel(dprFactor)}`);
  }
  const wheelEvents = detail0.wheelEvents;
  if (typeof wheelEvents === "number" && Number.isFinite(wheelEvents) && wheelEvents >= 0) {
    // 0 次要明说"没收到"：那是另一个成因（事件被引擎吃掉），跟 setZoom 没生效不是一回事。
    // 补一句"若只用过键盘/菜单则正常"——键盘通道（Ctrl+Shift+=/-）本来就不产生滚轮事件，
    // 少了这句会把"用户按快捷键"读成"滚轮事件被吃掉"（一次真实的误判就在这句上）。
    detail.push(
      wheelEvents === 0
        ? "本会话没收到 Ctrl+滚轮（只用过键盘/菜单时属正常）"
        : `收到 Ctrl+滚轮 ${wheelEvents} 次`,
    );
  }
  return `界面缩放未生效：引擎把 ${zoomLabel(target)} 限制在 ${zoomLabel(observed)}（${detail.join("；")}）`;
}

// ---------------------------------------------------------------------------
// 「缩放沉降窗口」——**缩放自己引发的 resize 不许重校 100% 基准**
// （2026-09-14 用户第五次反馈「还是会出现界面缩放未生效的 BUG」的根因，前端自己的锅）
//
// 链路：改档 → 引擎接受 → `window.innerWidth` 变了（WebView2 参考文档原话："Changing zoom
// factor may cause window.innerWidth, window.innerHeight, both, and page layout to change"）
// → 浏览器派发一次 `resize` → 页面里"用户拖窗口 → 重校 100% 基准"那条监听被触发，
// 而它用的是**改档前**的 `appliedZoom`：
//     新基准 = 新宽度 × 旧档位 = (100%宽 ÷ 新档位) × 旧档位
// 于是基准被压低成"新宽度"，复核再量就是 `基准 ÷ 当前宽度 = 1.0` —— 引擎明明接受了，却被读成
// 「引擎把 130% 限制在 100%（布局宽度没变）」，档位随即被拉回、界面真的弹回 100%。
// **只要引擎改档会引发 resize，这条误判就是必然的**（不是那台机器特殊）。
//
// 修法：从"我们让引擎改档"这一刻起到复核结束，收到的 resize 一律当作缩放自己引发的，
// 不重校基准（复核结束时由它自己按"当时的宽度 × 已知档位"校一遍，两个量都新鲜）。
// 用户真的拖窗口时：不在沉降窗口内 → 照常重校；正好撞进窗口内 → 由下一次复核重校，代价只是
// 这一次的读数偏一点（且窗口最多 ZOOM_SETTLE_MAX_MS）。
// ---------------------------------------------------------------------------

/** 改档后的沉降窗口长度：这期间的 resize 都算缩放自己引发的（复核正常在 1s 内结束，这只是兜底） */
export const ZOOM_SETTLE_MAX_MS = 2000;

/** 这次 resize 该不该重校 100% 基准（不在沉降窗口、也没有复核在跑 → 该） */
export function shouldRebaselineZoom(state: {
  now: number;
  settlingUntil: number;
  verifyInFlight: boolean;
}): boolean {
  if (state.verifyInFlight) return false;
  return !(state.now < state.settlingUntil);
}
