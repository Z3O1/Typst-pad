// 文件操作封装：Tauri 桌面环境用 dialog + invoke；纯浏览器环境降级提示。
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

const TYPST_FILTERS = [{ name: "Typst 文档", extensions: ["typ"] }];

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface OpenedFile {
  path: string;
  content: string;
}

/** 打开 .typ 文件对话框，返回路径与内容；取消返回 null */
export async function openTypFile(): Promise<OpenedFile | null> {
  if (!isTauri()) {
    alert("文件功能仅在 Tauri 桌面应用内可用（浏览器中请直接编辑）");
    return null;
  }
  const path = await open({ filters: TYPST_FILTERS, multiple: false });
  if (typeof path !== "string") return null;
  const content = await invoke<string>("read_file", { path });
  return { path, content };
}

/**
 * 保存内容到 path；path 为 null 时弹出另存为对话框。
 * 返回最终保存的路径；取消返回 null。
 */
export async function saveTypFile(
  path: string | null,
  content: string,
): Promise<string | null> {
  if (!isTauri()) {
    alert("文件功能仅在 Tauri 桌面应用内可用（浏览器中请直接编辑）");
    return null;
  }
  let target = path;
  if (!target) {
    target = await save({
      filters: TYPST_FILTERS,
      defaultPath: "untitled.typ",
    });
    if (!target) return null;
  }
  await invoke("write_file", { path: target, content });
  return target;
}
