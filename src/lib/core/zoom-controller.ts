// 界面缩放的**编排层**：把"用户改档 → 交给引擎 → 事后只观察"这条链路从 +page.svelte 搬出来。
//
// 纯判定/换算仍全在 zoom.ts（那里是纯函数 + 单测）；这一层管的是**有状态、有定时器、要读 DOM**
// 的部分：100% 基准、沉降窗口、复核代次、滚轮余量、再确认定时器。依赖全部由 hooks 注入，
// 所以单测里可以用假时钟 / 假宽度 / 假引擎把三条红线钉死。
//
// 三条红线（展开见 docs/实现细则/04-所见即所得.md 的「界面缩放」）：
// 1. **只观察、绝不改档**（0.8.0 用户明确的取舍）：复核量到的读数只用于调试日志与一句状态栏说明，
//    绝不写回档位、绝不回改引擎。用户原话「就应该缩放只有我能改，软件别自己动了」。
// 2. **沉降窗口**：从"我们让引擎改档"到复核结束之间，resize 不许重校 100% 基准 —— 引擎改档自己
//    会引发一次 resize，而那时档位估计还是旧值，一校就把基准压低，"引擎接受了"会被读成"引擎没动"
//    （用户第五次反馈「界面缩放未生效」的根因）。
// 3. **代次令牌**：新复核一开始旧复核立刻作废，否则旧读数会把新档位拉回引擎的旧值。
//
// 另外两条实现契约：`apply` 只在**用户操作**时调（页面 `$effect` 里 uiZoom 变化那条路）；
// 浏览器开发桩的假 `setZoom` 不做复核（`isFakeZoom`），但 `zoomsim=1` 的模拟引擎照常复核。

import {
  ZOOM_CONFIRM_DELAY_MS,
  ZOOM_DEFAULT,
  ZOOM_MEASURE_SETTLE_MS,
  ZOOM_SETTLE_MAX_MS,
  ZOOM_VERIFY_WAITS_MS,
  accumulateWheelSteps,
  clampZoom,
  createWheelAccumulator,
  resetWheelAccumulator,
  shouldRebaselineZoom,
  wheelPendingNotice,
  zoomApplied,
  zoomFromWidths,
  zoomIn,
  zoomLabel,
  zoomOut,
  zoomUnobservedNotice,
} from "./zoom";

export interface ZoomControllerHooks {
  /** 引擎可用吗（非 Tauri 环境直接跳过一切） */
  enabled(): boolean;
  /** 当前档位（页面持有的响应式值） */
  getLevel(): number;
  /**
   * 请求改档：页面负责 clamp、边界提示、写存档、以及把 uiZoom 交给引擎。
   * 控制器**不直接写档位**——它只表达"用户要这个值"。
   */
  requestLevel(level: number): void;
  /** 状态栏一句反馈（复核没观察到变化时的那句说明） */
  setStatus(text: string): void;
  /** 真正让引擎改档（Tauri 的 webview setZoom） */
  setWebviewZoom(level: number): Promise<void>;
  /** CSS 布局宽度：缩放判据 */
  layoutWidth(): number;
  devicePixelRatio(): number;
  /** 浏览器开发桩的 setZoom 是假的吗（假的就不复核） */
  isFakeZoom(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  nextFrame(): Promise<void>;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  log(message: string): void;
}

export interface ZoomController {
  /** 档位变化 → 交给引擎（页面在 `$effect` 里调；只在用户操作时触发） */
  apply(level: number): Promise<void>;
  /** 窗口/分栏尺寸变化（页面 resize 监听里调）：该重校基准时重校 */
  onResize(): void;
  /**
   * Ctrl+滚轮：换算 + 累加余量。返回 true 表示够一档、已经请求改档（页面早就 preventDefault 了）；
   * false 表示位移不足一档（状态栏已提示"攒到 N%"，档位不动）。
   */
  wheel(deltaY: number, deltaX: number, deltaMode: number): boolean;
  /** `Ctrl+Shift+=` / `-`、菜单 放大/缩小：±1 格（键盘调档没有半格，先丢掉滚轮余量） */
  step(steps: 1 | -1): void;
  /** 回到前台/重新聚焦时把当前档位再设一遍（值没丢时是空操作） */
  reapply(): void;
  /** 丢掉滚轮余量（重置缩放等整档操作） */
  resetWheel(): void;
  /** 组件销毁：取消还没落地的"再确认一次"（别在窗口关掉之后再去动引擎） */
  dispose(): void;
  /** 仅供诊断与单测：读内部状态（页面不渲染它） */
  debugState(): {
    appliedZoom: number;
    baseline100: number;
    dprAt100: number;
    verifyInFlight: boolean;
    settlingUntil: number;
    wheelEvents: number;
  };
}

export function createZoomController(hooks: ZoomControllerHooks): ZoomController {
  /** 我们对"引擎实际接受了多少缩放"的最佳估计：= **我们请求的档位**，只用于诊断读数与基准换算 */
  let appliedZoom = 1;
  /** 100% 时的 CSS 布局宽度（视口判据的基准） */
  let baseline100 = 0;
  /** 100% 时的 devicePixelRatio（第二条判据的基准，只做交叉验证） */
  let dprAt100 = 0;
  /** 沉降窗口截止时刻 */
  let settlingUntil = 0;
  /** 正在设一次缩放并测量（期间不接受 resize 改基准） */
  let stepInFlight = false;
  /** 复核代次令牌：新的复核一开始，旧的立刻作废 */
  let verifySeq = 0;
  /** "设完再确认一次"的定时器句柄 */
  let confirmTimer: number | null = null;
  /** 校准只做一次；并发调用共用同一个 promise */
  let calibration: Promise<void> | null = null;
  /** 本会话收到的带 Ctrl 的滚轮事件次数（只用于诊断文案） */
  let wheelEvents = 0;
  /** 滚轮位移的未走完余量（见 zoom.ts 的 accumulateWheelSteps） */
  const wheelAcc = createWheelAccumulator();

  function markSettling() {
    settlingUntil = hooks.now() + ZOOM_SETTLE_MAX_MS;
  }

  /** 按"当前档位 × 当前宽度"重校基准：缩放与用户拖窗口之后都要校，否则判据会失真 */
  function rebaseline() {
    const width = hooks.layoutWidth();
    if (width > 0 && appliedZoom > 0) baseline100 = width * appliedZoom;
  }

  /** 引擎**实际接受**的档位（读 CSS 布局宽度；量不到时 null = 本次不判定） */
  function engineZoomNow(): number | null {
    return zoomFromWidths(baseline100, hooks.layoutWidth());
  }

  /** 用 devicePixelRatio 反推的引擎档位（交叉验证用，不参与判定） */
  function dprZoomNow(): number | null {
    const dpr = hooks.devicePixelRatio();
    if (!(dprAt100 > 0) || !(dpr > 0) || !Number.isFinite(dpr)) return null;
    return dpr / dprAt100;
  }

  /** 设完缩放后等引擎重排完，再读一次"引擎实际接受的档位" */
  async function measureEngineZoom(): Promise<number | null> {
    await hooks.nextFrame();
    await hooks.sleep(ZOOM_MEASURE_SETTLE_MS);
    return engineZoomNow();
  }

  /**
   * 启动后校准一次：先把引擎设到 100%（顺便排掉 WebView2"记住上次站点缩放"的干扰），记下此时的
   * CSS 布局宽度作为基准。100% 是恒等档，任何引擎都会接受，所以这个基准可靠。
   */
  function ensureCalibration(): Promise<void> {
    if (calibration === null) {
      calibration = (async () => {
        try {
          markSettling(); // 校准本身也是一次改档（这一步引发的 resize 同样不该改基准）
          await hooks.setWebviewZoom(ZOOM_DEFAULT);
          await hooks.sleep(90);
          const width = hooks.layoutWidth();
          if (width > 0) {
            baseline100 = width;
            appliedZoom = ZOOM_DEFAULT;
          }
          const dpr = hooks.devicePixelRatio();
          if (Number.isFinite(dpr) && dpr > 0) dprAt100 = dpr;
          hooks.log(`校准：100% 布局宽度 ${width}px，dpr ${dpr}`);
        } catch (e) {
          hooks.log(`缩放校准失败（本次不判定引擎档位）：${String(e)}`);
        }
      })();
    }
    return calibration;
  }

  /** 手势/连续调档停止后再确认一次缩放；重复调用只保留最后一次 */
  function scheduleConfirm() {
    if (confirmTimer !== null) hooks.clearTimer(confirmTimer);
    confirmTimer = hooks.setTimer(() => {
      confirmTimer = null;
      const target = clampZoom(hooks.getLevel());
      markSettling();
      void hooks
        .setWebviewZoom(target)
        .then(() => {
          hooks.log(`confirm ${zoomLabel(target)}`);
          void observe(target);
        })
        // 这次是兜底重试，失败只记日志（首次调用已经把失败报过了）
        .catch((e) => hooks.log(`confirm failed：${String(e)}`));
    }, ZOOM_CONFIRM_DELAY_MS);
  }

  async function apply(zoom: number): Promise<void> {
    if (!hooks.enabled()) return;
    const target = clampZoom(zoom);
    // 先校准 100% 基线（只做一次），后面才能把视口宽度换算成"引擎实际接受的档位"
    await ensureCalibration();
    // 改档前若处于"已沉降"状态，先把基准按**当前档位**校一遍：沉降窗口里被跳过的 resize
    // （用户拖了窗口）在这里自愈。连滚多档时不校 —— 那时的档位估计可能还没跟上真实值。
    const settled = shouldRebaselineZoom({
      now: hooks.now(),
      settlingUntil,
      verifyInFlight: stepInFlight,
    });
    if (settled) rebaseline();
    markSettling();
    try {
      await hooks.setWebviewZoom(target);
      appliedZoom = target;
      hooks.log(`set ${zoomLabel(target)}`);
    } catch (e) {
      hooks.log(`setZoom failed：${String(e)}`);
      return;
    }
    scheduleConfirm();
  }

  /**
   * 改档之后**只观察、不改状态**（0.8.0 用户明确要求）。量到的读数只用于调试日志 + 一句状态栏
   * 说明；**绝不写档位、绝不回改引擎**。因此"引擎上限"这类机器上状态可能高于引擎实际给的档位
   * （死区回来了）——那是用户接受的代价，真要收也该由用户自己按 Ctrl+Shift+-。
   */
  async function observe(target: number): Promise<void> {
    if (hooks.isFakeZoom()) return;
    if (calibration === null) return; // 还没校准过（正常路径一定先经过 apply）
    const mySeq = ++verifySeq;
    let observed: number | null = null;
    let observedDpr: number | null = null;
    let measurements = 0;
    stepInFlight = true;
    markSettling();
    try {
      for (const wait of ZOOM_VERIFY_WAITS_MS) {
        if (wait > 0) await hooks.sleep(wait);
        if (mySeq !== verifySeq) return; // 用户又调档了：这次观察作废
        measurements += 1;
        observed = await measureEngineZoom();
        observedDpr = dprZoomNow();
        if (zoomApplied(target, observed) || zoomApplied(target, observedDpr)) break;
      }
    } catch (e) {
      hooks.log(`观察缩放结果时出错：${String(e)}`);
      return;
    } finally {
      if (mySeq === verifySeq) {
        stepInFlight = false;
        settlingUntil = 0; // 观察收尾：之后引擎再触发 resize 就是用户拖窗口
      }
    }
    if (mySeq !== verifySeq) return;
    const currentWidth = hooks.layoutWidth();
    if (zoomApplied(target, observed) || zoomApplied(target, observedDpr)) {
      hooks.log(`观察：引擎侧与请求一致（${zoomLabel(target)}）`);
      return;
    }
    // **没有观察到变化**：可能是引擎没接受，也可能是两条判据都读不出来（真机上出现过）。
    // 无论哪种，都只写一句说明，档位保持用户操作后的值。
    hooks.log(
      `观察：没看到引擎侧变化（请求 ${zoomLabel(target)}，实测 ${
        observed === null ? "读不到" : observed.toFixed(3)
      }，量了 ${measurements} 次；布局宽度 ${Math.round(baseline100)}→${Math.round(currentWidth)}）`,
    );
    hooks.setStatus(
      zoomUnobservedNotice(target, observed, {
        measurements,
        widths: { baseline: baseline100, current: currentWidth },
        dpr: hooks.devicePixelRatio(),
        dprFactor: observedDpr,
        wheelEvents,
      }),
    );
  }

  return {
    apply,

    onResize() {
      const allowed = shouldRebaselineZoom({
        now: hooks.now(),
        settlingUntil,
        verifyInFlight: stepInFlight,
      });
      if (!allowed) {
        hooks.log("resize（缩放沉降窗口内，跳过基准重校）");
        return;
      }
      rebaseline();
    },

    wheel(deltaY, deltaX, deltaMode) {
      // 计数只用于**诊断**（写进"未生效"文案）："页面压根没收到 Ctrl+滚轮"与"收到了但引擎没动"
      // 是完全不同的两个成因，前者说明事件在到达页面之前就被吃掉了。
      wheelEvents += 1;
      const steps = accumulateWheelSteps(wheelAcc, deltaY, deltaX, deltaMode);
      if (steps === 0) {
        // 不足一档：不动档位，但把"攒了多少"说出来 —— 否则"位移太小"和"事件没到页面"
        // 在用户眼里完全一样（都是滚了没反应），而那两件事的修法完全不同（见 zoom.ts）。
        hooks.setStatus(wheelPendingNotice(wheelAcc));
        return false;
      }
      const level = hooks.getLevel();
      hooks.requestLevel(steps > 0 ? zoomIn(level, steps) : zoomOut(level, -steps));
      return true;
    },

    step(steps) {
      resetWheelAccumulator(wheelAcc); // 键盘调档没有"半格"这回事：丢掉滚轮留下的余量
      const level = hooks.getLevel();
      hooks.requestLevel(steps > 0 ? zoomIn(level) : zoomOut(level));
    },

    reapply() {
      if (hooks.isFakeZoom()) return;
      void apply(hooks.getLevel());
    },

    resetWheel() {
      resetWheelAccumulator(wheelAcc);
    },

    dispose() {
      if (confirmTimer !== null) {
        hooks.clearTimer(confirmTimer);
        confirmTimer = null;
      }
    },

    debugState() {
      return {
        appliedZoom,
        baseline100,
        dprAt100,
        verifyInFlight: stepInFlight,
        settlingUntil,
        wheelEvents,
      };
    },
  };
}
