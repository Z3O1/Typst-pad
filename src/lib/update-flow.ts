// 自动更新流程的**纯决策层**（从 +page.svelte 搬出来）：检查结果、用户点「稍后」、安装结果
// 分别该把「状态机 / 状态栏 / 弹窗」摆成什么样。真正的 IPC（checkForUpdate /
// downloadAndInstallUpdate / closeUpdate）与持久化仍留在页面，这里只做决定。
//
// 两条红线（展开见 docs/实现细则/05-窗口与更新.md）：
// 1. **点过「稍后」= 以后自动检查只更新状态栏**（不弹窗、**也不动状态文字**），直到用户手动检查
//    —— 用户原话「不更新就再也别跳出来，直到点了检查更新」。别再退回"静默 6 小时"那种时间窗口版。
// 2. **Esc / 关闭只把更新窗收起来，绝不写 `updateDismissedAt`**（那等于替用户点了「稍后」）。
//    所以这份模块里**只有 `planDismiss` 会产出 `dismissedAt`**；页面的 Esc 路径根本不经过它。

import {
  UPDATE_DISMISS_NOTICE,
  formatBytes,
  isUpdatePromptSuppressed,
  type UpdateFlow,
} from "./update-utils";
import type { AvailableUpdate, CheckOutcome } from "./updater";

/** 下载安装的结果（= updater.downloadAndInstallUpdate 的返回形状） */
export type InstallOutcome = { ok: true } | { ok: false; message: string };

/** 手动检查开始时的状态栏文案 */
export const CHECKING_STATUS = "正在检查更新…";
/** 非 Tauri 环境（浏览器开发模式）手动检查的反馈 */
export const UNSUPPORTED_STATUS = "当前环境不支持自动更新（仅桌面版可用）";
/** 手动检查且已是最新 */
export const LATEST_STATUS = "已是最新版本";
/** 安装包已启动（Windows 上应用随即退出并重开） */
export const INSTALLING_STATUS = "更新已就绪：应用即将退出并安装新版本…";

/**
 * 状态栏的更新提示文案（点击可重开更新弹窗）；无需提示时为 null。
 * 「稍后」之后自动检查仍会走到这里 —— 状态栏那个「可更新到 vX」入口就是用户的回头路。
 */
export function updateNoticeText(flow: UpdateFlow): string | null {
  if (flow.kind === "available") return `可更新到 v${flow.version}`;
  if (flow.kind === "downloading") {
    return flow.progress.percent === null
      ? `正在下载更新 v${flow.version}（已下载 ${formatBytes(flow.progress.downloaded)}）`
      : `正在下载更新 v${flow.version}（${flow.progress.percent}%）`;
  }
  return null;
}

export interface UpdateCheckPlan {
  flow: UpdateFlow;
  /** 要写进状态栏的文案；**null = 不动状态栏**（自动检查保持安静） */
  status: string | null;
  /** 要不要弹更新窗 */
  openDialog: boolean;
}

/**
 * 检查结果 → 下一步。`manual` = 用户从菜单/状态栏点的（必须有明确反馈）；自动检查保持安静：
 * 没更新、失败都只在状态机里留痕 + 调试日志，绝不刷状态栏。
 */
export function planUpdateCheck(
  outcome: CheckOutcome,
  opts: { manual: boolean; dismissedAt: number | null },
): UpdateCheckPlan {
  const { manual, dismissedAt } = opts;
  switch (outcome.kind) {
    case "none":
      return {
        flow: { kind: "latest" },
        status: manual ? LATEST_STATUS : null,
        openDialog: false,
      };
    case "unsupported":
      return {
        flow: { kind: "idle" },
        status: manual ? UNSUPPORTED_STATUS : null,
        openDialog: false,
      };
    case "error":
      return {
        flow: { kind: "error", message: outcome.message },
        status: manual ? `检查更新失败：${outcome.message}` : null,
        openDialog: false,
      };
    case "available": {
      const update: AvailableUpdate = outcome.update;
      // 点过「稍后」之后，自动检查只把入口留在状态栏（见 updateNoticeText）：**不弹窗、也不动
      // 状态文字**。手动检查永远弹窗（页面在那之前已经 clearUpdateDismissed 了）。
      const suppressed = !manual && isUpdatePromptSuppressed(dismissedAt);
      return {
        flow: {
          kind: "available",
          version: update.version,
          currentVersion: update.currentVersion,
          notes: update.notes,
        },
        status: suppressed ? null : `发现新版本 v${update.version}`,
        openDialog: !suppressed,
      };
    }
  }
}

/** 弹窗里点「稍后」：记下时刻（**只有这一条路会写它**），关窗并说明后果 */
export function planDismiss(now: number): { dismissedAt: number; status: string } {
  return { dismissedAt: now, status: UPDATE_DISMISS_NOTICE };
}

/** 点「下载并安装」：先切到下载态（进度从 0 开始，总长未知 → percent = null） */
export function planInstallStart(version: string): UpdateFlow {
  return {
    kind: "downloading",
    version,
    progress: { downloaded: 0, total: 0, percent: null },
  };
}

/**
 * 下载安装的结果 → 下一步。失败**必须弹窗让用户看见**（否则点了按钮好像什么也没发生）；
 * 成功切到安装态（Windows 上应用随即退出，不需要用户再点）。
 */
export function planInstallResult(
  result: InstallOutcome,
  version: string,
): { flow: UpdateFlow; status: string; openDialog: boolean } {
  if (result.ok) {
    return { flow: { kind: "installing", version }, status: INSTALLING_STATUS, openDialog: false };
  }
  return {
    flow: { kind: "error", message: result.message },
    status: `更新失败：${result.message}`,
    openDialog: true,
  };
}
