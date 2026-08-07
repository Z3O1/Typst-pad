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

/** 判断路径是否为 .typ 文件（大小写不敏感） */
export function isTypPath(path: string): boolean {
  return path.toLowerCase().endsWith(".typ");
}

/** 从路径数组中选出第一个 .typ 文件；没有则返回 null */
export function pickTypPath(paths: string[]): string | null {
  return paths.find(isTypPath) ?? null;
}

/** 打开文件对话框选择 .typ 文件，返回路径；取消返回 null */
export async function openTypFile(): Promise<string | null> {
  if (!isTauri()) {
    alert("文件功能仅在 Tauri 桌面应用内可用（浏览器中请直接编辑）");
    return null;
  }
  const path = await open({ filters: TYPST_FILTERS, multiple: false });
  return typeof path === "string" ? path : null;
}

/** 按路径读取 .typ 文件内容（供打开/拖放/关联打开复用） */
export async function readTypFile(path: string): Promise<OpenedFile> {
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

/** 弹出系统"另存为"对话框（默认文件名 defaultName），返回目标绝对路径；取消返回 null */
export async function savePdfDialog(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null;
  const target = await save({
    filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    defaultPath: defaultName,
  });
  return typeof target === "string" ? target : null;
}
