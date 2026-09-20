// capabilities/default.json 的静态体检（vitest，纯读文件，普通 JS）。
//
// **为什么要有这一条**：Tauri 2 的 ACL 拒绝**只在运行到那一步时**才出现（状态栏会写
// 「Command plugin:xxx|yyy not allowed by ACL」），而浏览器验收跑在假的 `__TAURI_INTERNALS__`
// 上、根本碰不到真实 ACL —— 0.7.9 就是这样把一个「按 Ctrl+Shift+N 新建窗口 → 报 ACL 拒绝」的
// 版本发出去的：`core:webview:default` 里**没有** `allow-create-webview-window`，
// 而 `new WebviewWindow()` 走的正是 `plugin:webview|create_webview_window`。
//
// 这里把「前端确实用到的每条插件命令 → 需要的权限」钉成一张表，并核对窗口名单覆盖新窗口的 label。
// 改动 `src/` 里任何 Tauri 调用后，请顺手回来补一行。
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAPABILITY_PATH = "src-tauri/capabilities/default.json";
/** tauri-build 生成的 ACL 清单（未入库，只在本地跑过 cargo 构建后存在）：用来防权限名拼错 */
const MANIFEST_PATH = "src-tauri/gen/schemas/acl-manifests.json";

const capability = JSON.parse(readFileSync(CAPABILITY_PATH, "utf8"));

/**
 * 前端实际用到的调用 → 必须存在的权限（改前端调用时同步维护）。
 * 每条都写清是哪个功能在用它，免得后人以为可以精简掉。
 */
const REQUIRED = [
  {
    permission: "core:webview:allow-create-webview-window",
    usedBy: "new WebviewWindow()（Ctrl+Shift+N 新建窗口 / 文件 → 新建窗口）",
  },
  { permission: "core:window:allow-close", usedBy: "getCurrentWindow().close()（Ctrl+W、关窗）" },
  {
    permission: "core:window:allow-destroy",
    usedBy: "未保存确认里 destroy()（不再次触发 close-requested）",
  },
  { permission: "core:window:allow-set-title", usedBy: "窗口标题同步「文件名 - Typst-pad ●」" },
  { permission: "core:webview:allow-set-webview-zoom", usedBy: "Ctrl+滚轮界面缩放（setZoom）" },
  { permission: "dialog:default", usedBy: "打开 / 保存 / 另存为 系统对话框" },
  { permission: "updater:default", usedBy: "自动更新检查与下载安装" },
  {
    permission: "opener:default",
    usedBy: "打开外部链接（关于弹窗的「项目主页」→ plugin:opener|open_url）",
  },
  { permission: "core:default", usedBy: "基础能力（事件、窗口查询、路径、is-focused 等）" },
];

/** 简单 glob → 正则（capability 的 windows 名单只用到 `*`） */
const globMatch = (glob, label) => new RegExp(`^${glob.replace(/[*]/g, ".*")}$`).test(label);

describe("Tauri capability：前端用到的命令都有权限", () => {
  it.each(REQUIRED)("$permission（$usedBy）", ({ permission }) => {
    expect(capability.permissions).toContain(permission);
  });

  it("窗口名单覆盖主窗口与新窗口（editor-<时间戳>），且不误放别的 window", () => {
    const labels = capability.windows;
    const covered = (label) => labels.some((g) => globMatch(g, label));
    expect(covered("main")).toBe(true);
    expect(covered(`editor-${Date.now()}`)).toBe(true);
    expect(covered("editor-1")).toBe(true);
    expect(covered("other-1")).toBe(false);
  });
});

describe("Tauri capability：权限标识符本身有效（防拼错）", () => {
  const hasManifest = existsSync(MANIFEST_PATH);
  // 清单由 tauri-build 在 cargo 构建时生成、不入库：CI 只跑前端测试时没有它，
  // 那就只靠上面那张 REQUIRED 表兜着（本地跑过 cargo check / tauri dev 后会自动生效）。
  const manifest = hasManifest ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) : null;

  it.runIf(hasManifest)("每个权限都能在 acl-manifests.json 里查到", () => {
    expect(manifest).not.toBeNull();
    for (const permission of capability.permissions) {
      const cut = permission.lastIndexOf(":");
      const pluginId = permission.slice(0, cut);
      const permissionId = permission.slice(cut + 1);
      const plugin = manifest[pluginId];
      expect(plugin, `未知插件：${pluginId}`).toBeTruthy();
      const known =
        permissionId === "default" ? plugin.default_permission : plugin.permissions?.[permissionId];
      expect(known, `未知权限：${permission}`).toBeTruthy();
    }
  });

  it.runIf(hasManifest)(
    "webview 的默认权限集合里确实没有 create-webview-window（记下这个坑）",
    () => {
      const defaults = manifest["core:webview"]?.default_permission?.permissions;
      expect(defaults).toBeTruthy();
      expect(defaults).not.toContain("allow-create-webview-window");
    },
  );
});
