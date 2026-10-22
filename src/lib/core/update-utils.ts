// 自动更新的**纯逻辑**（不碰 Tauri API，可单测）：下载进度换算、错误文案、说明裁剪。
// 与 Tauri 交互的部分在 updater.ts；页面只负责把这里的结果摆到状态栏 / 弹窗上。

/**
 * 启动后延迟多久做首次自动检查。
 * 不放在 mount 里立刻做：首次编译、恢复上次内容、字体加载都在抢启动那几秒，
 * 更新检查延后到首屏之后，不与恢复和首次编译竞争。
 */
export const AUTO_CHECK_DELAY_MS = 4000;

// 自动检查与弹窗规则：
//   * 启动时**每次都做自动检查**（只受设置里「启动时自动检查更新」开关约束）——网络请求照发，
//     所以新版本一来状态栏那个「可更新到 vX」入口就会出现，不会让你彻底蒙在鼓里；
//   * 自动检查**不再自己弹窗**，前提是用户点过更新弹窗里的「稍后」（= `updateDismissedAt` 有值）；
//   * **手动检查（「帮助 → 检查更新…」）永远弹窗**，并且**清掉这个"别烦我"标记** ——
//     这就是用户说的"直到点了检查更新"，之后自动弹窗恢复正常；
//   * 点状态栏的更新入口、点「下载并安装」同样算显式操作，也会清掉标记。
//   实现见 +page.svelte 的 checkUpdates / dismissUpdatePrompt / openUpdateDialogFromNotice。

/**
 * 用户点过「稍后」之后的状态栏提示（说明"以后不会再自动弹，但可以手动查"）。
 * 验收里断言的就是这句话，改文案要两边一起改。
 */
export const UPDATE_DISMISS_NOTICE = "已停止自动提示更新（「帮助 → 检查更新…」随时可手动检查）";

/**
 * 自动检查是否应该**只更新状态栏、不弹窗**：`dismissedAt` 有合法值就是"用户说过不更新"。
 * 非法 / 缺失 → false = 照常弹窗（**默认是弹，别写反**：没点过「稍后」的人应该正常看到新版本）。
 * 值本身只是"什么时候点的"（诊断用），不参与时间窗口计算 —— 用户要的是"再也别跳"，不是"过几小时再跳"。
 */
export function isUpdatePromptSuppressed(dismissedAt: number | null | undefined): boolean {
  return typeof dismissedAt === "number" && Number.isFinite(dismissedAt) && dismissedAt > 0;
}

/** 字节数 → 人类可读（B / KB / MB / GB）；非法或非正值一律 "0 B" */
export function formatBytes(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // 字节数取整；KB 以上保留一位小数，超过 100 时也取整（"523 MB" 比 "523.4 MB" 好读）
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** 下载进度：字节数 + 百分比（总长未知时 percent 为 null，只能显示已下载量） */
export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number | null;
}

/**
 * 更新流程状态机（原来内联在 +page.svelte，现在页面与 UpdateDialog 共用这一份类型）。
 *
 * 刻意做成**单个可判别联合**而不是若干布尔量：状态栏提示、弹窗内容、按钮可用性都由它派生，
 * 避免出现"弹窗开着但状态是 idle""下载中又是 available"这类自相矛盾的组合
 * （更新流程有 7 个阶段，布尔量一多必然打架）。
 */
export type UpdateFlow =
  | { kind: "idle" }
  | { kind: "checking"; manual: boolean }
  | { kind: "latest" }
  | { kind: "available"; version: string; currentVersion: string; notes: string }
  | { kind: "downloading"; version: string; progress: DownloadProgress }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

/**
 * 由「已下载字节 / 总字节」算进度。总数未知（服务端没给 Content-Length）或非法时
 * percent = null —— 不能用 0 冒充，否则进度条会一直空着却以为在动弹。
 */
export function progressFrom(downloaded: number, total: number): DownloadProgress {
  const safeDownloaded =
    typeof downloaded === "number" && Number.isFinite(downloaded) && downloaded > 0
      ? downloaded
      : 0;
  const safeTotal = typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
  const percent =
    safeTotal > 0
      ? Math.max(0, Math.min(100, Math.round((safeDownloaded / safeTotal) * 100)))
      : null;
  return { downloaded: safeDownloaded, total: safeTotal, percent };
}

/** 进度文案（弹窗与状态栏共用）：有总长给百分比，没有就给已下载量 */
export function formatProgress(progress: DownloadProgress): string {
  if (progress.percent === null) return `已下载 ${formatBytes(progress.downloaded)}`;
  return `已下载 ${progress.percent}%（${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}）`;
}

/**
 * 更新报错只展示简短原因与处理建议，不向用户输出内部路径或发布排障信息。
 */
export function describeUpdateError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === undefined || error === null
          ? ""
          : String(error);
  const lower = raw.trim().toLowerCase();

  if (lower.includes("signature")) {
    return "更新包签名校验失败，请重新下载或手动安装。";
  }
  // 注意顺序：「target not found」必须排在通用 not found 之前，否则会被当成"清单取不到"
  if (lower.includes("target not found") || lower.includes("targetnotfound")) {
    return "暂不支持本平台的自动更新，请手动下载安装包。";
  }
  if (
    lower.includes("could not fetch a valid release json") ||
    lower.includes("404") ||
    lower.includes("not found")
  ) {
    return "暂时无法获取更新，请稍后重试或手动下载安装包。";
  }
  if (
    lower.includes("dns") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("connect") ||
    lower.includes("network") ||
    lower.includes("error sending request")
  ) {
    return "连接更新服务器失败，请检查网络或代理后重试。";
  }
  if (
    lower.includes("permission") ||
    lower.includes("not allowed") ||
    lower.includes("forbidden")
  ) {
    return "更新被系统权限拦截，请手动下载安装包。";
  }
  return "更新失败，请稍后重试或手动下载安装包。";
}
