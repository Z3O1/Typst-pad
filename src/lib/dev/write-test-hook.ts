// 浏览器验收用的**页面级只读钩子**（`?browserdev=1` 才挂）：块表的排版戳 + 写作编译调度器的计数。
//
// 为什么需要（PR #77 复审的第 7 条）：`writing-stability.mjs` 的"改版心宽之后切片与链接热区成套重建"
// 那条断言只比了 resize 前后的 crop 数 / href / 百分比位置 —— 产品**完全不重编译、继续用旧 DOM**
// 恰好也全绿（列宽变化只证明 CSS 容器变了）。要让那条断言真的有意义，就得看见两件 DOM 里
// 看不出来的事：① 这一轮**重新编译过**（`compile_blocks` 计数，桩自己记）；② 新块表带的是
// **新的 layout 修订号**（页面内部状态）。同理，复审第 2 条要断言"写作模式的编译不再有绕过
// 调度器的入口"，也需要调度器的 `runs` 计数与 `compile_blocks` 次数对得上。
//
// **只在浏览器开发模式挂上去**：桌面版地址没有 `?browserdev`，下面两个函数都是空操作，
// 产品行为零变化。钩子全是**只读**的（读计数、读快照），不接受页面对它的任何写回。
import { browserDevEnabled } from "./editor-test-hook";
import type { RenderStamp } from "../core/block-state";
import type { WritingCompileSchedulerStats } from "../core/writing-compile-scheduler";

/** 块表当前的出身（页面在 `applyBlocksPatch` / `resetBlocks` 时报告） */
export interface WriteTestBlocks {
  stamp: RenderStamp;
  geometryId: number;
  /** 块表是"精确"的还是沿用/估算的（`writingBlocksExact`） */
  exact: boolean;
  /** 块数 / 其中标记 `stale` 的块数 */
  blocks: number;
  stale: number;
}

interface HookHost {
  __typstPadBlocks?: WriteTestBlocks | null;
  __typstPadScheduleStats?: () => WritingCompileSchedulerStats;
}

function hookHost(): HookHost {
  return window as unknown as HookHost;
}

/** 登记调度器计数读取器（页面创建调度器之后调用一次；桌面版是空操作） */
export function registerWriteTestHooks(stats: () => WritingCompileSchedulerStats): void {
  if (!browserDevEnabled()) return;
  hookHost().__typstPadScheduleStats = stats;
}

/** 报告块表出身（每次块表落地都调；`null` = 块表已清空） */
export function reportWriteTestBlocks(state: WriteTestBlocks | null): void {
  if (!browserDevEnabled()) return;
  hookHost().__typstPadBlocks = state;
}

/** 组件销毁时撤销登记（避免多窗口/重挂载后读到已拆页面的计数） */
export function unregisterWriteTestHooks(): void {
  if (!browserDevEnabled()) return;
  const host = hookHost();
  delete host.__typstPadBlocks;
  delete host.__typstPadScheduleStats;
}
