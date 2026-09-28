// 文件操作封装：Tauri 桌面环境用 dialog + invoke；纯浏览器环境降级提示。
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { pastedImageName } from "./paste";

const TYPST_FILTERS = [{ name: "Typst 文档", extensions: ["typ"] }];

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface OpenedFile {
  path: string;
  content: string;
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
export async function saveTypFile(path: string | null, content: string): Promise<string | null> {
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

/**
 * 选择字体目录（设置 → 额外字体目录）：把字体文件丢进该目录即可被 typst 使用，
 * 等价于 typst CLI 的 `--font-path`。取消返回 null；浏览器环境返回 null。
 */
export async function pickFontDir(): Promise<string | null> {
  if (!isTauri()) return null;
  const dir = await open({ directory: true, multiple: false });
  return typeof dir === "string" ? dir : null;
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

/** 目录分隔符：Windows 的 `\` 与 POSIX 的 `/` 都要认（保存对话框给的是本地路径） */
function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut);
}

/** 粘贴图片的落盘序号：同一秒里连贴多张也各不相同 */
let pastedImageSeq = 0;

/**
 * **粘贴进来的图片写进文档旁边**（typora-parity 审计 P0-4）。
 *
 * 策略（第一版，明确、可预期）：
 *  - 目标目录 = **文档所在目录**，文件名 `image-<时间戳>-<序号>.<ext>`（只用时间戳与序号，
 *    绝不用剪贴板里的原始文件名 —— 那可能带路径分隔符）；
 *  - 返回**相对文档目录**的路径，直接写进 `#image("…")`：Typst 按文档路径解析相对资源，
 *    所以移动整个目录仍然成立；
 *  - 未保存的文档（没有路径）**拒绝**并提示先保存 —— 不猜目录、不隐式写盘（见 files-and-security）；
 *  - 写盘走既有 `write_binary`（Rust 侧 `validate_write_path`：必须绝对路径、拒 `..`、拒符号链接），
 *    浏览器开发模式由 dev 桩实现（并记录调用，供验收断言）。
 */
export async function savePastedImage(docPath: string | null, file: File): Promise<string> {
  if (!isTauri()) throw new Error("图片只能保存到本地磁盘（浏览器模式不支持）");
  if (!docPath) throw new Error("请先保存文档，再粘贴图片");
  const dir = dirOf(docPath);
  if (dir === "") throw new Error("文档路径无效，无法确定图片目录");
  const name = pastedImageName(file.type, new Date(), pastedImageSeq++);
  const target = `${dir}/${name}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // `Vec<u8>` 走 JSON 数组（与 Rust 侧 write_binary 的签名一致）；图片通常是几百 KB，
  // 这个形状够用，将来换二进制通道也不必改调用点语义。
  await invoke("write_binary", { path: target, bytes: Array.from(bytes) });
  return name;
}
