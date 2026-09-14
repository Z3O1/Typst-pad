// 自动更新的**纯逻辑**（不碰 Tauri API，可单测）：下载进度换算、错误文案、说明裁剪。
// 与 Tauri 交互的部分在 updater.ts；页面只负责把这里的结果摆到状态栏 / 弹窗上。

/**
 * 启动后延迟多久做首次自动检查。
 * 不放在 mount 里立刻做：首次编译、恢复上次内容、字体加载都在抢启动那几秒，
 * 更新检查要走网络，晚一点做对启动耗时没有任何影响（见 startup-timing.ts）。
 */
export const AUTO_CHECK_DELAY_MS = 4000;

// 这里曾经有一个 `AUTO_CHECK_MIN_INTERVAL_MS`（6 小时）+ `isCheckDue(lastCheckAt, now)`：
// 「同一台机器两次自动检查至少隔 6 小时」。**别再把它加回来**——2026-09-14 用户报「自动更新没法用」，
// 复现出来的现象就是它造成的：那次启动的自动检查被上一条时间戳拦掉了（安装完 0.7.6 时记的），
// 于是"打开应用"永远不会自己发现新版本，只有手动点「检查更新」才查得到（用户原话：
// 「打开的时候没有自动更新，但是检查的时候能检查到」）。而且**手动检查也会刷新那个时间戳**，
// 于是越频繁手动查、启动时越不可能自动查，这个组合特别难自己撞见。
//
// 现在的规则：启动时**每次都查一次**（只受设置里的「启动时自动检查更新」开关约束）。
// 代价是每次启动多两个 HTTPS 请求（清单 + 重定向），换到的是"打开就看到新版本"这个用户预期；
// 桌面编辑器本来就该在启动时自报新版本（VS Code / Typora 同理）。`lastUpdateCheckAt` 现在
// **只是一条记录**（诊断用：出问题时能看出上次检查是什么时候），不再参与任何判定。

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
