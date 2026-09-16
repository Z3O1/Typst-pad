// 写作模式的源码透镜要装进 webview 的**打包字体**（Rust 侧 `typst_world::EDITOR_FONT_FILES`
// 的镜像；`scripts/editor-fonts.test.mjs` 静态对齐两边，改名/换文件时会红）。
//
// 为什么需要它：写作模式 = "非光标块显示引擎切片 + 光标所在块展开成源码"。字号（`--write-doc-px`）
// 与行高（typst 的 `par.leading`）早已跟着文档走，**字体是最后一条腿** ——
// 切片是 typst 用下面这两族打包字体排出来的，而 webview 里的源码此前只能用系统字体栈
// （Windows 上落到宋体 + Times），同一段文字在两种形态里字宽、断行都不一样，光标进出块时
// 看起来像"换了一套字"。
//
// 这三份字体本来就随应用分发（`bundle.resources` 的 `fonts/`），所以装进 webview 不增加安装包体积：
// Rust 侧 `bundled_font` 命令读出字节（raw IPC → ArrayBuffer），这里用 **FontFace JS API** 注册
// （不必拼 `@font-face` CSS，也不必造 blob URL）。装不上（老后端没有这个命令 / 文件缺失）就什么都
// 不做 —— 字体栈自动退回原来的系统衬线族，绝不能因此让编辑区出问题。
import { invoke } from "@tauri-apps/api/core";

/** 一份要注册的字体面 */
export interface EditorFontFace {
  /** 打包字体的文件名（与 Rust 白名单一一对应） */
  file: string;
  /** `@font-face` 的 family —— 与 typst 的族名一致，CSS 字体栈里直接写这个名字 */
  family: string;
  weight: "400" | "700";
}

/** 与 Rust `EDITOR_FONT_FILES` 一一对应：拉丁 Libertinus Serif（正文 + 粗体）、中文思源宋体子集 */
export const EDITOR_FONT_FACES: readonly EditorFontFace[] = [
  { file: "LibertinusSerif-Regular.otf", family: "Libertinus Serif", weight: "400" },
  { file: "LibertinusSerif-Bold.otf", family: "Libertinus Serif", weight: "700" },
  { file: "NotoSerifCJKsc-Regular.otf", family: "Noto Serif CJK SC", weight: "400" },
];

/**
 * 写作模式正文的字体栈：**顺序与 typst 的 `DEFAULT_FONT_FAMILIES` 一致**
 * （拉丁 Libertinus → 中文思源宋体 → 系统宋体兜底），打包那份是子集，生僻字仍由系统字体接住。
 */
export const WRITE_FONT_STACK =
  '"Libertinus Serif", "Noto Serif CJK SC", "Songti SC", "Source Han Serif SC", Georgia, serif';

/** 装载字体所需的依赖（留出注入点，便于单测；真机上就是 invoke + document.fonts） */
export interface EditorFontDeps {
  /** 取一份字体的字节 */
  load: (file: string) => Promise<ArrayBuffer>;
  /** 造一个字体面（默认用全局 `FontFace`；jsdom 里没有，所以做成可注入） */
  makeFace?: (family: string, bytes: ArrayBuffer, weight: string) => { load(): Promise<unknown> };
  /** 注册目标（默认 `document.fonts`） */
  fonts?: { add(face: unknown): void } | null;
}

/**
 * 注册打包字体，返回**真正装上的族名**（去重）。
 *
 * 逐份独立 try/catch：坏一份不影响其它份、更不影响编辑区（最坏就是那族名退回系统字体）。
 */
export async function installEditorFonts(
  deps: EditorFontDeps,
  faces: readonly EditorFontFace[] = EDITOR_FONT_FACES,
): Promise<string[]> {
  const makeFace =
    deps.makeFace ??
    (typeof FontFace === "function"
      ? (family: string, bytes: ArrayBuffer, weight: string) =>
          new FontFace(family, bytes, { weight, style: "normal" })
      : null);
  const fonts = deps.fonts ?? (typeof document !== "undefined" ? document.fonts : null);
  if (!makeFace || !fonts) return [];

  const loaded: string[] = [];
  for (const face of faces) {
    try {
      const bytes = await deps.load(face.file);
      const font = makeFace(face.family, bytes, face.weight);
      await font.load();
      fonts.add(font);
      loaded.push(face.family);
    } catch (e) {
      console.warn(`[editor-font] 打包字体没装上（退回系统字体）：${face.file}`, e);
    }
  }
  return [...new Set(loaded)];
}

/** 从 Rust 侧取打包字体的字节（真机路径；浏览器开发模式由 stub 顶上） */
export async function loadBundledFont(file: string): Promise<ArrayBuffer> {
  const bytes = await invoke<ArrayBuffer | number[] | Uint8Array>("bundled_font", { name: file });
  if (bytes instanceof ArrayBuffer) return bytes;
  // 兜底：老后端 / 别的 IPC 形态（数组、TypedArray）也能用
  if (Array.isArray(bytes)) return new Uint8Array(bytes).buffer;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  throw new Error("字体字节格式不对");
}
