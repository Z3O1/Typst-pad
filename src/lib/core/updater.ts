// 自动更新的 Tauri 包装层：把 @tauri-apps/plugin-updater 的原始 API
// （check → Update 句柄 → downloadAndInstall 事件流）收敛成页面好用的形状：
// 检查结果是一个可判别的联合类型，下载进度是 update-utils 里的纯结构。
//
// 三条约定：
// 1. **只在 Tauri 内调用**（浏览器 / 浏览器开发模式直接返回 unsupported），
//    否则 check() 会打到一个不存在的 IPC 命令上；
// 2. 所有异常都收敛成返回值（`{ kind: "error" }` / `{ ok: false }`），
//    不让 promise 拒绝冒到页面的 unhandledrejection（那会在状态栏刷红字）；
// 3. Update 句柄持有 Rust 侧资源（rid），换版本时必须 close()，否则泄漏。
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./file-ops";
import { dbg } from "./debug";
import { describeUpdateError, progressFrom, type DownloadProgress } from "./update-utils";

/** 可用的新版本（handle 是 plugin 的 Update 句柄，下载/安装都靠它） */
export interface AvailableUpdate {
  handle: Update;
  /** 新版本号（如 "0.8.0"） */
  version: string;
  /** 当前运行的版本号 */
  currentVersion: string;
  /** 更新说明（latest.json / Release 的 notes，可能为空） */
  notes: string;
  /** 发布日期（ISO 字符串，可能为空） */
  date: string;
}

/** 检查更新的结果 */
export type CheckOutcome =
  | { kind: "none" }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "error"; message: string }
  /** 非 Tauri 环境（浏览器 / 浏览器开发模式）：没有可用的更新通道 */
  | { kind: "unsupported" };

/**
 * 检查更新。任何失败都返回 `{ kind: "error" }`，调用方只要看 statusText 就行。
 */
export async function checkForUpdate(): Promise<CheckOutcome> {
  if (!isTauri()) return { kind: "unsupported" };
  try {
    const update = await check();
    // 新版本 API：无更新时 check() 返回 null（旧版靠 update.available 判断，已废弃）
    if (!update) return { kind: "none" };
    dbg.log("updater", `available ${update.currentVersion} → ${update.version}`);
    return {
      kind: "available",
      update: {
        handle: update,
        version: update.version,
        currentVersion: update.currentVersion,
        notes: (update.body ?? "").trim(),
        date: update.date ?? "",
      },
    };
  } catch (e) {
    dbg.log("updater", "check failed", e);
    return { kind: "error", message: describeUpdateError(e) };
  }
}

/**
 * 下载并安装更新，下载过程中回调进度。
 *
 * Windows 上 `downloadAndInstall` 在**成功启动安装程序后就会退出应用**（安装程序自己
 * 把应用重新拉起来），所以这个 promise 可能不会返回——`{ ok: true }` 只表示"走到安装那步前没报错"。
 */
export async function downloadAndInstallUpdate(
  update: AvailableUpdate,
  onProgress: (progress: DownloadProgress) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let downloaded = 0;
  let total = 0;
  try {
    await update.handle.downloadAndInstall((event) => {
      if (event.event === "Started") {
        // 服务端没给 Content-Length 时 contentLength 为 undefined → total = 0 → 进度只有字节数
        total = event.data.contentLength ?? 0;
        downloaded = 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
      }
      // "Finished" 之后紧接着就进安装流程，不再单独报一次 100%：
      // 安装阶段由页面切到"正在安装"状态显示
      if (event.event !== "Finished") onProgress(progressFrom(downloaded, total));
    });
    dbg.log("updater", `installed ${update.version}`);
    return { ok: true };
  } catch (e) {
    dbg.log("updater", "install failed", e);
    return { ok: false, message: describeUpdateError(e) };
  }
}

/** 释放更新句柄（Rust 侧资源）。换版本/丢弃待安装更新时调用，失败忽略。 */
export async function closeUpdate(update: AvailableUpdate | null): Promise<void> {
  if (!update) return;
  try {
    await update.handle.close();
  } catch {
    // 句柄可能已被插件回收（如安装完成），忽略
  }
}
