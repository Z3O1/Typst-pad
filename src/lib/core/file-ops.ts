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
 * 启动对指定 .typ 文件的监控；同一窗口再次调用会先停止旧 watch。
 * 浏览器环境为空操作（无真实文件访问）。
 */
export async function startFileWatch(path: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("start_file_watch", { path });
}

/** 停止当前窗口的文件监控；浏览器环境为空操作。 */
export async function stopFileWatch(): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_file_watch");
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

/** 目录部分（**含末尾分隔符**）：Windows 的 `\` 与 POSIX 的 `/` 都要认（保存对话框给的是本地路径） */
function dirPrefix(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

/** 粘贴图片的落盘序号：同一秒里连贴多张也各不相同 */
let pastedImageSeq = 0;

/**
 * **粘贴进来的图片写进文档旁边**，返回写进源码的**相对路径**。
 *
 * 策略（第一版，明确、可预期）：
 *  - 目标目录 = **文档所在目录**，文件名 `image-<时间戳>-<序号>.<ext>`（不用剪贴板里的原始
 *    文件名 —— 那可能带路径分隔符，见 `core/paste.ts` 的 `pastedImageName`）；
 *  - 返回相对文档目录的路径，直接写进 `#image("…")`：Typst 按文档路径解析相对资源，
 *    整个目录一起搬走仍然成立；
 *  - 未保存的文档（没有路径）**拒绕**并提示先保存 —— 不猜目录、不隐式写盘；
 *  - 写盘走既有 `write_binary`（Rust 侧 `validate_write_path`：必须绝对路径、拒 `..`、
 *    父目录必须存在、拒符号链接；只新建不覆盖）。
 */
export async function savePastedImage(docPath: string | null, file: File): Promise<string> {
  if (!isTauri()) throw new Error("图片只能保存到本地磁盘（浏览器模式不支持）");
  if (!docPath) throw new Error("请先保存文档，再粘贴图片");
  const dir = dirPrefix(docPath);
  if (dir === "") throw new Error("文档路径无效，无法确定图片目录");
  const at = new Date();
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  // `write_binary` 只新建不覆盖：撞名（同一秒的两份进程、或磁盘上已经有同名文件）就换下一个
  // 序号重试，避免改掉用户已有的图片。
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const name = pastedImageName(file.type, at, pastedImageSeq++);
    try {
      await invoke("write_binary", { path: `${dir}${name}`, bytes });
      return name;
    } catch (error) {
      if (!String(error).includes("目标文件已存在")) throw error;
    }
  }
  throw new Error("无法为粘贴的图片分配文件名，请重试");
}
