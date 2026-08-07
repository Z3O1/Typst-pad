// 启动阶段耗时打点：轻量封装（O(1) 数组 push），不阻塞主流程。
// 首次编译完成后一次性输出报告（console.group + table），供启动性能观测/回归对比。
// 保留该模块：成本可忽略，且为「启动太慢」类问题提供可复现的量化数据。
export interface StartMark {
  name: string;
  t: number;
}

const marks: StartMark[] = [];
let reported = false;

/** 记录一个时间点，返回时间戳（供局部差值计算） */
export function mark(name: string): number {
  const t = performance.now();
  marks.push({ name, t });
  return t;
}

/** 已记录的打点（测试/调试用，返回副本） */
export function getMarks(): StartMark[] {
  return marks.slice();
}

/** 输出启动报告（仅一次）：阶段表 + 页面加载阶段耗时 */
export function reportStartup(): void {
  if (reported || marks.length === 0) return;
  reported = true;
  const t0 = marks[0].t;
  // 机器可读单行（headless 日志抓取用）：[startup] phase:<name> t:<ms>
  for (const m of marks) {
    console.log(`[startup] phase:${m.name} t:${(m.t - t0).toFixed(1)}`);
  }
  // 页面加载阶段（document 下载 → JS 完成 → load），补全 JS 侧打点之前的窗口
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav) {
      console.log(`[startup] phase:nav-responseEnd t:${(nav.responseEnd - nav.startTime).toFixed(1)}`);
      console.log(
        `[startup] phase:nav-domContentLoaded t:${(nav.domContentLoadedEventEnd - nav.startTime).toFixed(1)}`,
      );
      console.log(`[startup] phase:nav-load t:${(nav.loadEventEnd - nav.startTime).toFixed(1)}`);
    }
  } catch {
    // 环境不支持 navigation timing 时忽略
  }
}
