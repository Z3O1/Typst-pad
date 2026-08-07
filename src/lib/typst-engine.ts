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

/** Rust 侧结构化诊断：1-based 行列；path 为空表示主文档 */
export interface Diagnostic {
  message: string;
  severity: "error" | "warning";
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  path?: string;
}

/** compile_doc 成功产物：pages 为每页 SVG 字符串（按页序） */
export interface CompileOutputOk {
  ok: true;
  pages: string[];
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
  /** 诊断来源路径；空/缺失表示主文档（编辑器为其画波浪线），本地库等为各自路径（跳过） */
  path?: string;
}

export interface CompileOk {
  ok: true;
  svg: string;
  pageCount: number;
  /** 编译警告（Rust 侧携带；当前 UI 不展示，保留供后续使用） */
  warnings?: Diagnostic[];
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

/** 单条结构化诊断 → 编辑器用的错误位置（end 缺省回退为起点；1-based 原样透传） */
export function diagnosticToLocation(d: Diagnostic): CompileErrorLocation {
  return {
    message: d.message,
    line: d.line,
    col: d.column,
    endLine: d.endLine ?? d.line,
    endCol: d.endColumn ?? d.column,
    path: d.path,
  };
}

/** 全部 error 级诊断 → 编辑器错误位置列表（warning 级不参与波浪线/错误计数） */
export function errorLocations(diagnostics: Diagnostic[]): CompileErrorLocation[] {
  return diagnostics
    .filter((d) => d.severity === "error")
    .map(diagnosticToLocation);
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
 */
export async function compileToSvg(
  source: string,
  documentPath: string | null,
): Promise<CompileResult> {
  try {
    const out = await invoke<CompileOutput>("compile_doc", { src: source, documentPath });
    if (out.ok) {
      return {
        ok: true,
        svg: composePages(out.pages),
        pageCount: out.pages.length,
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

/**
 * 导出 PDF：由建议文件名推导默认名 → 弹系统"另存为"对话框选定目标路径 →
 * invoke export_pdf 让 Rust 侧编译并直接落盘。取消对话框返回 cancelled，
 * 导出失败返回 error（调用方展示错误并保留预览）。
 */
export async function compileToPdf(
  source: string,
  documentPath: string | null,
  suggestedName: string,
): Promise<PdfExportResult> {
  const target = await savePdfDialog(pdfFileName(suggestedName));
  if (!target) return { ok: false, cancelled: true };
  const res = await invoke<{ ok: boolean; error?: string }>("export_pdf", {
    src: source,
    documentPath,
    targetPath: target,
  });
  if (res.ok) return { ok: true, targetPath: target };
  return { ok: false, cancelled: false, error: res.error ?? "PDF 导出失败：未生成产物" };
}
