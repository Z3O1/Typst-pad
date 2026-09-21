// 桌面窗口级事件的两条规则：**文件拖放**与**关闭确认**。
//
// 从 `+page.svelte` 的 `onMount` 里搬出来（原来直接写在 Tauri 监听的回调体里）。这两条以前只在
// 桌面版走得到、单测够不着，而它们各有一条"看起来对、写错了才知道"的规则：
//
// 1. **拖放**：`over` / `enter` 亮覆盖层，落下或离开时灭掉；落下时**只认 `.typ`**（`pickTypPath`
//    取第一个），一个 `.typ` 都没有时**只有在真的拿到路径**（`paths.length > 0`）才提示
//    「仅支持打开 .typ 文件」——拖了别的文件要提示，而系统没给路径（拖到窗口空白处之类）就别
//    无中生有一句报错。
// 2. **关闭确认**：**按内容判定**而不是看 `dirty` 标志（`isEffectiveDirty`）——输入过又删光的文档
//    `dirty` 仍是 true，但已经没什么可丢的，此时**不许拦**关闭；有内容才 `preventDefault()` 并弹
//    前端自定义的三按钮弹窗（不用 dialog 插件的返回值，保证 保存/不保存/取消 语义可靠）。
import { isEffectiveDirty } from "./doc-utils";
import { pickTypPath } from "./file-ops";

/** 拖放事件类型（Tauri `onDragDropEvent` 的 `payload.type`，`| string` 是给别的收尾态留口） */
export type DragEventType = "over" | "enter" | "drop" | "leave";

/** 一个 `.typ` 都没有、但确实拖进来了东西时的状态栏提示 */
export const REJECT_DROP_STATUS = "仅支持打开 .typ 文件";

export interface DropHooks {
  /** 拖放覆盖层提示的开关（页面里的 `dragActive`） */
  setDragActive(active: boolean): void;
  /** 打开选中的文件（页面侧就是 `docSession.openPath`） */
  openPath(path: string): unknown;
  /** 状态栏文案 */
  setStatus(text: string): void;
}

export interface DropHandler {
  /** 处理一条拖放事件；`paths` 只有 `drop` 才有 */
  handle(type: DragEventType | string, paths?: readonly string[]): void;
}

export function createDropHandler(hooks: DropHooks): DropHandler {
  return {
    handle(type, paths) {
      if (type === "over" || type === "enter") {
        hooks.setDragActive(true);
        return;
      }
      hooks.setDragActive(false); // drop / leave：先收掉覆盖层
      if (type !== "drop") return;
      const list = paths === undefined ? [] : [...paths];
      const path = pickTypPath(list);
      if (path) {
        void hooks.openPath(path);
      } else if (list.length > 0) {
        hooks.setStatus(REJECT_DROP_STATUS);
      }
    },
  };
}

/** 关闭请求事件：只需要 `preventDefault`（与 Tauri `CloseRequestedEvent` 的形状对齐） */
export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface CloseGuardHooks {
  doc(): string;
  dirty(): boolean;
  /** 有可丢内容时弹确认（页面里 `showClosePrompt = true`） */
  prompt(): void;
}

export interface CloseGuard {
  handle(event: CloseRequestEvent): void;
}

export function createCloseGuard(hooks: CloseGuardHooks): CloseGuard {
  return {
    handle(event) {
      // 没有可丢的内容（干净 / 空文档）→ 什么都不做，放行关闭
      if (!isEffectiveDirty(hooks.dirty(), hooks.doc())) return;
      event.preventDefault();
      hooks.prompt();
    },
  };
}
