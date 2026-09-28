// **按键 → 首帧的分段打点**（typora-parity 审计 P1-7）：把一次编辑里几段已知的**纯前端**工作分开计时。
//
// 为什么要它：整个链路的端到端延迟（`writing-perf.mjs` 量的 p50/p95）只能告诉我们"慢不慢"，
// 说不出**慢在哪一段** —— 而"按键 → 调度 → 编译落地 → 装饰重建"里前端能改的只有其中几段。
// 有了分段落，优化前后就能逐段对比（基线在 `.browser-check/perf-baseline.json`）。
//
// **只有浏览器开发模式（`?browserdev=1`）才记录**：`enabled` 是模块级布尔，生产构建里恒为 false，
// 每个 `timeIt` 只多一次判断。计数与耗时都是普通数字，不持有文档引用。
export interface PerfMark {
  count: number;
  totalMs: number;
  maxMs: number;
}

let enabled = false;
const marks = new Map<string, PerfMark>();

/** 由 dev 钩子在挂载编辑器时打开（生产 / 单测保持关闭） */
export function setPerfMarksEnabled(on: boolean): void {
  enabled = on;
  if (!on) marks.clear();
}

/** 记一段时间（毫秒） */
export function recordPerfMark(name: string, ms: number): void {
  if (!enabled) return;
  const cur = marks.get(name);
  if (cur === undefined) marks.set(name, { count: 1, totalMs: ms, maxMs: ms });
  else {
    cur.count += 1;
    cur.totalMs += ms;
    if (ms > cur.maxMs) cur.maxMs = ms;
  }
}

/**
 * 给一段同步工作计时（返回原值）。**别把异步函数包进来** —— 那样量到的是"到第一个 await 为止"。
 * 没开打点时零额外分配（只有一次布尔判断）。
 */
export function timeIt<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordPerfMark(name, performance.now() - t0);
  }
}

/** 读快照（分段名 → 次数 / 累计 / 单次最大，毫秒） */
export function perfMarkStats(): Record<string, PerfMark> {
  const out: Record<string, PerfMark> = {};
  for (const [k, v] of marks) out[k] = { ...v };
  return out;
}

/** 清计数（性能基线一轮开始前调） */
export function resetPerfMarks(): void {
  marks.clear();
}
