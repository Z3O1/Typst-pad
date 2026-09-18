// 自动更新的**纯逻辑**（不碰 Tauri API，可单测）：下载进度换算、错误文案、说明裁剪。
// 与 Tauri 交互的部分在 updater.ts；页面只负责把这里的结果摆到状态栏 / 弹窗上。

/**
 * 启动后延迟多久做首次自动检查。
 * 不放在 mount 里立刻做：首次编译、恢复上次内容、字体加载都在抢启动那几秒，
 * 更新检查要走网络，晚一点做对启动耗时没有任何影响（见 startup-timing.ts）。
 */
export const AUTO_CHECK_DELAY_MS = 4000;

// 关于自动检查更新"要不要节流 / 要不要弹窗"这条路（2026-09-14，三轮，别走回头路）：
//
// 1) 最早有一道 `AUTO_CHECK_MIN_INTERVAL_MS`（6 小时）+ `isCheckDue(lastCheckAt, now)`：
//    「同一台机器两次自动检查至少隔 6 小时」。用户报「自动更新没法用」，复现出来就是它——
//    那次启动的检查被上一条时间戳（安装完 0.7.6 时记下的）拦掉了，于是**打开应用永远不会自己
//    发现新版本**，只有手动点「检查更新」才查得到（用户原话：「打开的时候没有自动更新，但是
//    检查的时候能检查到」）。更坑的是**手动检查也会刷新那个时间戳**，越手动查越不会自动查。
//    → 这道"按时间无条件静默"的节流已删除，启动时每次都查。
// 2) 中途按"点稍后 → 静默 6 小时"实现过一版，被用户否掉：
//    **「算了，不更新就再也别跳出来，直到点了检查更新」**。
//
// 现在的规则（最终版）：
//   * 启动时**每次都做自动检查**（只受设置里「启动时自动检查更新」开关约束）——网络请求照发，
//     所以新版本一来状态栏那个「可更新到 vX」入口就会出现，不会让你彻底蒙在鼓里；
//   * 自动检查**不再自己弹窗**，前提是用户点过更新弹窗里的「稍后」（= `updateDismissedAt` 有值）；
//   * **手动检查（「帮助 → 检查更新…」）永远弹窗**，并且**清掉这个"别烦我"标记** ——
//     这就是用户说的"直到点了检查更新"，之后自动弹窗恢复正常；
//   * 点状态栏的更新入口、点「下载并安装」同样算显式操作，也会清掉标记。
//   实现见 +page.svelte 的 checkUpdates / dismissUpdatePrompt / openUpdateDialogFromNotice。
//   **不要再往启动路径上加任何"上次检查时间"式的无条件节流。**

/**
 * 用户点过「稍后」之后的状态栏提示（说明"以后不会再自动弹，但可以手动查"）。
 * 验收里断言的就是这句话，改文案要两边一起改。
 */
export const UPDATE_DISMISS_NOTICE =
  "已停止自动提示更新（「帮助 → 检查更新…」随时可手动检查）";

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
    safeTotal > 0 ? Math.max(0, Math.min(100, Math.round((safeDownloaded / safeTotal) * 100))) : null;
  return { downloaded: safeDownloaded, total: safeTotal, percent };
}

/** 进度文案（弹窗与状态栏共用）：有总长给百分比，没有就给已下载量 */
export function formatProgress(progress: DownloadProgress): string {
  if (progress.percent === null) return `已下载 ${formatBytes(progress.downloaded)}`;
  return `已下载 ${progress.percent}%（${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}）`;
}

/**
 * 更新相关报错 → 用户能看懂的一句话。
 * 原文照抄进日志，但状态栏/弹窗只给可行动的解释：这些错误几乎都发生在
 * "网络不通""清单/资产还没发出来""签名对不上"三类里，直接甩英文原文用户没法处理。
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
  const message = raw.trim();
  const lower = message.toLowerCase();

  if (lower.includes("signature")) {
    return `更新包签名校验失败（可能是下载不完整或来源被篡改），请稍后重试或到 GitHub Releases 手动下载。原始错误：${message}`;
  }
  // 注意顺序：「target not found」必须排在通用 not found 之前，否则会被当成"清单取不到"
  if (lower.includes("target not found") || lower.includes("targetnotfound")) {
    return `这次发布的安装包里没有本平台的更新包（仅发布了部分平台）。原始错误：${message}`;
  }
  if (
    lower.includes("could not fetch a valid release json") ||
    lower.includes("404") ||
    lower.includes("not found")
  ) {
    // 这条错误我们实际踩过两次：插件对**非 2xx** 只记日志、当成"没有 release"，最后统一报成
    // "Could not fetch a valid release JSON from the remote"，所以字面上完全看不出是 404。
    // 三个已知原因按可能性排序。2026-09-14 之前排在第一位的是"仓库是私有的"（当时确实是私有，
    // 匿名请求一律 404）；那一天仓库已转公开（`gh api repos/Z3O1/Typst-pad --jq .private` → false），
    // 所以现在主因变成"清单还没发出来"，私有只作为"你把它改回私有 / fork 到私有仓库"的兜底提示。
    // 排查时先看仓库可见性，再确认 Release 是不是 Publish 过了。
    return `没有取到更新清单（latest.json）。常见原因：① 该版本还没发布、Release 还是草稿（草稿资产客户端拿不到，必须 Publish）；② 网络不通；③ 仓库是私有的——客户端的更新检查不带任何 GitHub 凭据，匿名请求私有仓库一律 404。原始错误：${message}`;
  }
  if (
    lower.includes("dns") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("connect") ||
    lower.includes("network") ||
    lower.includes("error sending request")
  ) {
    return `连接更新服务器失败（检查网络或代理设置）。原始错误：${message}`;
  }
  if (lower.includes("permission") || lower.includes("not allowed") || lower.includes("forbidden")) {
    return `没有执行更新的权限（安装程序可能被系统策略拦下），可到 GitHub Releases 手动下载安装包。原始错误：${message}`;
  }
  return message === "" ? "未知错误" : message;
}
