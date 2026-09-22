// 浏览器验收用的**开发测试钩子**：把正在运行的 `EditorView` 暴露到 `window.__typstPadView`。
//
// 为什么需要它：`scripts/browser-check/` 下的套件一直用
// `document.querySelector(".cm-content").cmTile.root.view` 取视图 —— 那是 CodeMirror 的**内部**
// 结构（`cmTile` / `root` 都不是公开 API），内部字段一改，所有套件一起红，而且报错只会是
// "cannot read properties of undefined"，看不出是取视图的方式坏了。新增的
// `writing-stability.mjs` 要逐帧读 `contentHeight` / `coordsAtPos` / `scrollDOM`，更需要一条
// 稳定的取法（见报告 T0：「通过开发测试钩子读取 CM 状态，逐步替代内部取法」）。
//
// **只在浏览器开发模式（URL 带 `?browserdev=1`）挂上去**：桌面版的地址没有这个参数，
// `registerEditorView` 就只是一次普通赋值，产品行为零变化。
import type { EditorView } from "@codemirror/view";
import { docScanStats } from "../editor/live-preview/doc-scan";

/** 当前页是不是浏览器开发模式（与 browser-dev-stub 的开关是同一个查询参数） */
function browserDevEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("browserdev");
  } catch {
    return false;
  }
}

/** 取 `window` 上的钩子字段（同一份声明，读写两处共用，避免名字写岔） */
function hookHost(): { __typstPadView?: EditorView } {
  return window as unknown as { __typstPadView?: EditorView };
}

/** 编辑器挂载时登记；桌面版（无 `?browserdev=1`）是空操作 */
export function registerEditorView(view: EditorView): void {
  if (!browserDevEnabled()) return;
  hookHost().__typstPadView = view;
  // 文档扫描缓存的命中/未命中计数（报告 T3 / P1）：验收要断言"纯选区移动不重新扫描全文"，
  // 而这件事在 DOM 上看不出来 —— 只能读计数。
  (window as unknown as { __typstPadScanStats?: () => unknown }).__typstPadScanStats = docScanStats;
}

/** 编辑器销毁时撤销登记（只撤自己那一个实例，避免多窗口/重挂载后留一个已销毁的视图） */
export function unregisterEditorView(view: EditorView): void {
  if (!browserDevEnabled()) return;
  const host = hookHost();
  if (host.__typstPadView === view) delete host.__typstPadView;
  delete (window as unknown as { __typstPadScanStats?: unknown }).__typstPadScanStats;
}
