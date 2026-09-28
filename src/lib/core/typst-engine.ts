// Typst 编译引擎：Tauri 进程内原生编译（compile_doc / export_pdf 命令）。
// WASM 编译器（typst.ts）已移除：编译/PDF 导出/字体/include 解析全部由 Rust 侧完成，
// 前端只负责发起命令并消费结构化结果。SVG 产物来自可信进程内编译，不再净化。
import { invoke } from "@tauri-apps/api/core";
import { savePdfDialog } from "./file-ops";
import { pdfFileName } from "./pdf-export";
import { dbg } from "./debug";

// ---------------------------------------------------------------------------
// 接口契约（Rust 侧实现，见 T1 任务契约）：
// invoke("compile_doc", { src, documentPath }) → CompileOutput
// invoke("export_pdf", { src, documentPath, targetPath }) → { ok, error? }
//
// documentPath 语义（T1 联调确认）：已保存文档 → 绝对路径（Rust 以其所在目录为
// include 解析根）；未保存新文档 → null。传相对字符串会被 Rust 以进程 CWD 为
// include 根解析，属错误用法。
// ---------------------------------------------------------------------------

/**
 * Rust 侧结构化诊断：1-based 行列；**缺省（或旧版本的 `null`/空串）表示主文档**。
 *
 * 契约细节（2026-09-18 修）：Rust 侧对主源诊断**整个键都不发**
 * （`Diagnostic::path` 带 `skip_serializing_if`），子文件（include/import）才给路径。
 * 这里仍然收 `null` —— 0.4.0~0.8.2 发的是 `"path":null`，前端按 `undefined`/`""` 判定，
 * 于是主源编译错误全被当成"非主源文件"跳过、**一条波浪线都不画**（见 diagnostics-utils.ts）。
 */
export interface Diagnostic {
  message: string;
  severity: "error" | "warning";
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  path?: string | null;
}

/** compile_doc 成功产物：pages 为每页 SVG 字符串（按页序） */
export interface CompileOutputOk {
  ok: true;
  pages: string[];
  geometryId?: number;
  warnings?: Diagnostic[];
}

/** compile_doc 编译失败：错误诊断列表 */
export interface CompileOutputFail {
  ok: false;
  diagnostics: Diagnostic[];
}

export type CompileOutput = CompileOutputOk | CompileOutputFail;

/** 编译错误的源码位置（1-based 行列；end 为独占终点），供编辑器画波浪线 / hover 提示 */
export interface CompileErrorLocation {
  message: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /**
   * 诊断来源路径；**缺失 / `null` / 空串都表示主文档**（编辑器为它画波浪线），
   * 本地库等为各自路径（跳过）。`null` 是 Rust 0.4.0~0.8.2 的写法，见 Diagnostic 注释。
   */
  path?: string | null;
}

export interface CompileOk {
  ok: true;
  svg: string;
  pageCount: number;
  geometryId?: number;
  /** 编译警告（Rust 侧携带；UI 在状态栏徽标里展示，字体族写错只有这里看得见） */
  warnings?: Diagnostic[];
}

/**
 * 传给 Rust 的字体配置（对应 typst_world/fonts.rs 的 FontConfig）。
 * 三项都可缺省：families 缺省/null = 用 Rust 内置的 DEFAULT_FONT_FAMILIES。
 */
export interface FontConfigArgs {
  /** 默认字体族列表（顺序即优先级）；null = 用 Rust 默认列表（中文 = 思源宋体 + 系统宋体兜底） */
  families?: string[] | null;
  /** 额外字体目录（对齐 typst CLI 的 --font-path / TYPST_FONT_PATHS） */
  dirs?: string[] | null;
}

/** 组装 invoke 的字体参数：缺省一律传 null，Rust 侧回落到默认行为 */
function fontArgs(fonts?: FontConfigArgs) {
  return {
    fontFamilies: fonts?.families ?? null,
    fontDirs: fonts?.dirs ?? null,
  };
}

/**
 * 列出可用字体族（设置里「正文字体」下拉的数据源）：打包字体 + 系统字体 + 额外目录。
 * 失败（浏览器环境 / IPC 异常）返回空数组，调用方退化成只能选「默认」。
 */
export async function listFontFamilies(dirs: string[] = []): Promise<string[]> {
  try {
    return await invoke<string[]>("list_font_families", { fontDirs: dirs });
  } catch {
    return [];
  }
}

/**
 * Rust 内置的默认字体族列表：前端拿它拼「用户选中项 + 其余默认项兜底」
 * （见 font-settings.buildFontFamilies）。失败返回空数组（此时只会用用户选的那一个）。
 */
export async function defaultFontFamilies(): Promise<string[]> {
  try {
    return await invoke<string[]>("default_font_families");
  } catch {
    return [];
  }
}

export interface CompileFail {
  ok: false;
  error: string;
  /** 所有可定位的编译错误（含位置）；无法解析出位置的错误会被跳过 */
  errors: CompileErrorLocation[];
}

export type CompileResult = CompileOk | CompileFail;

/** PDF 导出成功：目标路径为用户经"另存为"对话框选定的落盘位置 */
export interface PdfExportOk {
  ok: true;
  targetPath: string;
}

/** 用户取消"另存为"对话框 */
export interface PdfExportCancelled {
  ok: false;
  cancelled: true;
}

/** Rust 侧导出失败（编译错误 / 落盘失败等） */
export interface PdfExportFail {
  ok: false;
  cancelled: false;
  error: string;
}

export type PdfExportResult = PdfExportOk | PdfExportCancelled | PdfExportFail;

/** 单条结构化诊断 → 编辑器用的错误位置（end 缺省回退为起点；1-based 原样透传）
 *
 * `path` 归一化：Rust 的 `null`（0.8.2 及更早的写法）与「键缺失」都收敛成 `undefined`，
 * 下游只需要认一种"这是主源"的表示（见 Diagnostic 的注释）。
 */
export function diagnosticToLocation(d: Diagnostic): CompileErrorLocation {
  return {
    message: d.message,
    line: d.line,
    col: d.column,
    endLine: d.endLine ?? d.line,
    endCol: d.endColumn ?? d.column,
    path: d.path ?? undefined,
  };
}

/** 全部 error 级诊断 → 编辑器错误位置列表（warning 级不参与波浪线/错误计数） */
export function errorLocations(diagnostics: Diagnostic[]): CompileErrorLocation[] {
  return diagnostics.filter((d) => d.severity === "error").map(diagnosticToLocation);
}

/** 诊断消息格式化（带位置后缀；供无法定位的错误作为状态栏/弹窗文案） */
export function formatDiagnostic(d: Diagnostic): string {
  return `${d.message} (行 ${d.line}, 列 ${d.column})`;
}

/**
 * 每页 SVG 字符串 → 预览容器 HTML：按页序拼接，页间插入分隔线。
 * 页数与旧实现一致由页数直接得出（旧实现基于单文档内 typst-page 元素统计）。
 */
export function composePages(pages: string[]): string {
  return pages.join('<div class="page-separator"></div>');
}

/**
 * 编译 Typst 源码为 SVG 预览。失败返回错误结果对象（调用方保留上次成功预览），
 * 不抛异常；invoke/IPC 异常也收敛为错误结果（errors 为空，error 带原始消息）。
 *
 * 页面设置只来自文档与编译前缀；显示容器的宽度不进入编译输入。
 */
export async function compileToSvg(
  source: string,
  documentPath: string | null,
  fonts?: FontConfigArgs,
): Promise<CompileResult> {
  try {
    const out = await invoke<CompileOutput>("compile_doc", {
      src: source,
      documentPath,
      ...fontArgs(fonts),
    });
    if (out.ok) {
      return {
        ok: true,
        svg: composePages(out.pages),
        pageCount: out.pages.length,
        geometryId: out.geometryId,
        warnings: out.warnings,
      };
    }
    const errors = errorLocations(out.diagnostics);
    // 调试日志：原始诊断（结构化，severity/行列/path 原样输出）与转换后的位置列表各输出一次
    dbg.log("compile-diagnostics", "raw", out.diagnostics);
    dbg.log("compile-diagnostics", "converted", errors);
    const first = out.diagnostics[0];
    return {
      ok: false,
      error: first ? formatDiagnostic(first) : "编译失败：未生成产物",
      errors,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      errors: [],
    };
  }
}

export async function compileToPdf(
  source: string,
  documentPath: string | null,
  suggestedName: string,
  fonts?: FontConfigArgs,
): Promise<PdfExportResult> {
  const target = await savePdfDialog(pdfFileName(suggestedName));
  if (!target) return { ok: false, cancelled: true };
  const res = await invoke<{ ok: boolean; error?: string }>("export_pdf", {
    src: source,
    documentPath,
    targetPath: target,
    ...fontArgs(fonts),
  });
  if (res.ok) return { ok: true, targetPath: target };
  return { ok: false, cancelled: false, error: res.error ?? "PDF 导出失败：未生成产物" };
}

/** 编译源码的 UTF-8 字节位置与页面光标，单位 pt。 */
export interface DocumentCaret {
  offset: number;
  page: number;
  xPt: number;
  yPt: number;
  heightPt: number;
  rotationDeg?: number;
}

function validCaret(value: DocumentCaret | null): DocumentCaret | null {
  return value &&
    Number.isInteger(value.offset) &&
    value.offset >= 0 &&
    Number.isInteger(value.page) &&
    value.page > 0 &&
    [value.xPt, value.yPt, value.heightPt].every(Number.isFinite) &&
    value.heightPt > 0 &&
    (value.rotationDeg === undefined || Number.isFinite(value.rotationDeg))
    ? value
    : null;
}

export async function hitTestDocument(
  geometryId: number,
  page: number,
  xPt: number,
  yPt: number,
): Promise<DocumentCaret | null> {
  try {
    return validCaret(
      await invoke<DocumentCaret | null>("document_hit_test", { geometryId, page, xPt, yPt }),
    );
  } catch {
    return null;
  }
}

export async function locateDocumentCursor(
  geometryId: number,
  offset: number,
): Promise<DocumentCaret | null> {
  try {
    return validCaret(
      await invoke<DocumentCaret | null>("document_cursor", { geometryId, offset }),
    );
  } catch {
    return null;
  }
}
