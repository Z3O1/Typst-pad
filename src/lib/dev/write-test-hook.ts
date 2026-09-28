// 浏览器验收的只读入口：会话恢复状态与整页编译调度计数。
import { browserDevEnabled } from "./editor-test-hook";
import type { DocumentCompileSchedulerStats } from "../core/document-compile-scheduler";

interface HookHost {
  __typstPadScheduleStats?: () => DocumentCompileSchedulerStats;
  /**
   * **会话恢复完成**（`+page.svelte` 的 `onMount` 把存档落到 `$state` 之后置 true）。
   *
   * 子组件 onMount 比页面更早；验收须等设置与会话落地后再输入，
   * 避免读到默认主题或把尚未恢复的内容存回会话。
   */
  __typstPadRestored?: boolean;
}

function hookHost(): HookHost {
  return window as unknown as HookHost;
}

/** 登记调度器计数读取器（页面创建调度器之后调用一次；桌面版是空操作） */
export function registerWriteTestHooks(stats: () => DocumentCompileSchedulerStats): void {
  if (!browserDevEnabled()) return;
  hookHost().__typstPadScheduleStats = stats;
}

/** 报告"存档已经落到 $state 上"（`onMount` 的恢复段结束处调用；桌面版是空操作） */
export function reportSessionRestored(): void {
  if (!browserDevEnabled()) return;
  hookHost().__typstPadRestored = true;
}

/** 组件销毁时撤销登记（避免多窗口/重挂载后读到已拆页面的计数） */
export function unregisterWriteTestHooks(): void {
  if (!browserDevEnabled()) return;
  const host = hookHost();
  delete host.__typstPadScheduleStats;
  delete host.__typstPadRestored;
}
