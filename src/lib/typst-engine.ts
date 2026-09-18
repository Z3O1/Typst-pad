// Typst 编译引擎：Tauri 进程内原生编译（compile_doc / export_pdf 命令）。
// WASM 编译器（typst.ts）已移除：编译/PDF 导出/字体/include 解析全部由 Rust 侧完成，
// 前端只负责发起命令并消费结构化结果。SVG 产物来自可信进程内编译，不再净化。
import { invoke } from "@tauri-apps/api/core";
import { savePdfDialog } from "./file-ops";
import { pdfFileName } from "./pdf-export";
import { dbg } from "./debug";
import { TYPST_DEFAULT_TEXT_PT } from "./preview-scale";

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
  /** 编译警告（Rust 侧携带；UI 在状态栏徽标里展示，字体族写错只有这里看得见） */
  warnings?: Diagnostic[];
}

/**
 * 传给 Rust 的字体配置（对应 typst_world.rs 的 FontConfig）。
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
 *
 * `previewWidthPt`（可选）= 预览页宽（pt）：给了就按它**给预览重新排版**
 * （Rust 侧在编译源最前面注入 `#set page(width/height/margin)`，见
 * typst_world::preview_page_setup）——预览栏多宽、纸张就多宽，正文重排、字号不变，
 * 于是预览永不出现横向滚动条。**只影响预览**：导出 PDF 走 export_pdf，不受它影响。
 */
export async function compileToSvg(
  source: string,
  documentPath: string | null,
  fonts?: FontConfigArgs,
  previewWidthPt?: number,
): Promise<CompileResult> {
  try {
    const out = await invoke<CompileOutput>("compile_doc", {
      src: source,
      documentPath,
      previewWidthPt: previewWidthPt ?? null,
      ...fontArgs(fonts),
    });
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

// ---------------------------------------------------------------------------
// 写作模式的块级渲染（compile_blocks）：整篇编译一次 → 每个源块切一张 SVG
// 契约见 src-tauri/src/block_geometry.rs 的 BlockCrop / BlocksOutput。
// ---------------------------------------------------------------------------

/** Rust 侧的单块产物：偏移是**文档坐标的字节偏移**（已减掉编译前缀，见 block-offsets.ts） */
export interface BlockCrop {
  start: number;
  end: number;
  kind: string;
  /** 是否有渲染结果（`#let` / `#show` / 纯注释行没有） */
  found: boolean;
  /** 内容分布在几页（单张长页为 1） */
  pages: number;
  /** 切片所在页（1-based）—— 点击定位要在同一页里找字形 */
  page: number;
  /** 裁剪带在页面上的左缘 / 上缘（pt）：切片 SVG 的坐标系原点就是带的左上角 */
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  bands: number;
  /** 切片 SVG；空串 = 没有渲染结果 */
  svg: string;
  /**
   * 切片**内部**的链接热区（阶段 3"链接可点"）：坐标相对裁剪带左上角（pt，与 SVG 同坐标系）。
   * 只有窗口内的块才有（与 svg 同步取舍）；没有链接时为空/缺省。
   */
  links?: CropLink[];
}

/** 切片上的一个链接热区（相对裁剪带左上角，pt） */
export interface CropLink {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  href: string;
}

interface RawBlocksOutput {
  ok: boolean;
  blocks?: BlockCrop[];
  pages?: number;
  pageWidthPt?: number;
  /** 文档正文实际字号（pt）：源码透镜的字号基准，见 block_geometry::document_text_pt */
  textPt?: number;
  geometryId?: number;
  diagnostics?: Diagnostic[];
  warnings?: Diagnostic[];
}

export interface BlocksOk {
  ok: true;
  /** 判别用：与 BlocksUnavailable / BlocksFail 组成可判别联合 */
  unavailable: false;
  blocks: BlockCrop[];
  pageCount: number;
  /** 实际用于排版的页宽（pt），= 正文列宽 / (1 - 2×页边距比例) */
  pageWidthPt: number;
  /**
   * **文档正文实际字号**（pt，Rust 侧按字符数投票取众数）——写作模式"源码透镜"的字号基准：
   * 编辑器正文按它渲染，光标进出块时字号/行高才不会跳（用户：「不要光标在哪里哪里就变大了」）。
   * 后端没给（旧版本 / 浏览器桩）时回落到 typst 默认 11pt。
   */
  textPt: number;
  /**
   * **这一轮编译写进 Rust 侧 `HIT_CACHE` 的几何编号**（0 = 没有几何）。
   * 点切片时原样带回去（见 `hitTestBlock`）：几何是**进程级**的，多窗口下另一个窗口
   * 编译一次就会把它换掉，编号对不上时后端拒绝命中、前端退回"光标落到块首"
   * （PR #60 审查的第 4 条）。旧后端不给这个字段 → 0 → 不校验（老行为）。
   */
  geometryId: number;
  warnings?: Diagnostic[];
}

/** 后端没有这个命令（旧版本 / 浏览器开发桩）：调用方退回整页 SVG 预览路径 */
export interface BlocksUnavailable {
  ok: false;
  unavailable: true;
}

export interface BlocksFail {
  ok: false;
  unavailable: false;
  error: string;
  errors: CompileErrorLocation[];
}

export type BlocksResult = BlocksOk | BlocksUnavailable | BlocksFail;

/**
 * 写作模式的块级编译：整篇编译一次，Rust 侧把每个源块在版面上的那一块（含与相邻块的
 * 半个间距）切出来单独渲成 SVG —— 编辑器据此把"非光标所在块"显示成**真实 typst 排版**。
 *
 * `docOffsetBytes` = 编译前缀的 UTF-8 字节长度（用户文档在 `src` 里的起点），
 * `contentWidthPt` = 写作模式正文列宽（pt）—— 版心宽随编辑器列宽走。
 *
 * 诊断/警告的结构与 `compileToSvg` 完全一致（同一套状态栏/波浪线逻辑）。
 * 命令不存在（浏览器开发桩、旧后端）时返回 `unavailable`，由调用方退回整页预览。
 */
export async function compileBlocks(
  source: string,
  docOffsetBytes: number,
  documentPath: string | null,
  contentWidthPt: number,
  fonts?: FontConfigArgs,
  want?: { from: number; to: number } | null,
): Promise<BlocksResult> {
  let out: RawBlocksOutput | null;
  try {
    out = await invoke<RawBlocksOutput>("compile_blocks", {
      src: source,
      docOffset: docOffsetBytes,
      documentPath,
      contentWidthPt,
      // 窗口 = 只给这一段（文档坐标字节偏移）内的块渲切片；逐块 SVG 会各自复制字形轮廓
      // （实测约 58 字节/源字符），全渲在长文档下是每按键 10MB 级的开销。
      // 窗口外的块由前端按"块文本相同"沿用上一轮切片（见 block-plan.carryOverCrops）。
      wantFrom: want?.from ?? null,
      wantTo: want?.to ?? null,
      ...fontArgs(fonts),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 桩 / 旧版本后端的"没有这个命令"是**预期**情形（浏览器开发模式、老安装包），
    // 不是错误：交给调用方退回整页预览路径，不要显示成编译失败。
    // **判据只认"命令不存在"**：早先这里还带一个裸 `compile_blocks`，于是参数校验失败
    // （`invalid args ... for command compile_blocks`）、命令内 panic 之类也一并被吞成
    // "后端不支持"，用户看不到任何提示（PR #60 审查指出）。
    if (/not found|unknown command/i.test(message)) {
      return { ok: false, unavailable: true };
    }
    return { ok: false, unavailable: false, error: message, errors: [] };
  }
  // 形状不对 = 后端没实现这个命令（桩返回 null / 旧安装包）。
  // **失败结果必须有 `ok`，但不能要求 `blocks` 存在**：Rust 侧早先给 `blocks` 加了
  // `skip_serializing_if`，编译失败时那个键整个不发，于是"真机上任何 typst 错误"都被这里
  // 判成"后端不支持" ⇒ 退回整页预览、切片不撤、错误块不展开（PR #60 审查抓到）。
  // 现在 Rust 侧失败也发 `blocks: []`（见 `failure_output_always_carries_blocks_key`），
  // 这里再放宽一层：**判"后端有没有实现"只看 `ok` 这个键**，失败结果一律当编译失败处理。
  if (!out || typeof out !== "object" || typeof out.ok !== "boolean") {
    return { ok: false, unavailable: true };
  }
  if (out.ok) {
    if (!Array.isArray(out.blocks)) {
      return { ok: false, unavailable: true }; // 自称成功却没有块表 = 后端没实现
    }
    return {
      ok: true,
      unavailable: false,
      blocks: out.blocks,
      pageCount: out.pages ?? 1,
      pageWidthPt: out.pageWidthPt ?? contentWidthPt,
      textPt: typeof out.textPt === "number" && out.textPt > 0 ? out.textPt : TYPST_DEFAULT_TEXT_PT,
      geometryId: typeof out.geometryId === "number" ? out.geometryId : 0,
      warnings: out.warnings,
    };
  }
  const errors = errorLocations(out.diagnostics ?? []);
  const first = (out.diagnostics ?? [])[0];
  dbg.log("compile-diagnostics", "blocks raw", out.diagnostics);
  return {
    ok: false,
    unavailable: false,
    error: first ? formatDiagnostic(first) : "编译失败：未生成产物",
    errors,
  };
}

/**
 * **点击定位**（阶段 2）：把一个页面坐标点映射回"这个块里的哪个字节偏移"。
 *
 * 几何来自 Rust 侧上一次成功编译的缓存（`block_geometry::HIT_CACHE`），不重新编译，
 * 也不占编译通道 —— 一次调用是微秒级的线性扫描。
 *
 * * `fromByte` / `toByte` = 被点那个块的**文档字节区间**（`block_hit_test` 的钳制范围）；
 * * 返回值同样是**文档字节偏移**，由调用方换算成 CodeMirror 位置（见 block-offsets.ts）。
 *
 * 失败 / 后端没有这个命令（浏览器开发桩、旧安装包）/ 还没编译过 → null，
 * 调用方退回"光标落到块首"的老行为，绝不因为定位失败而吞掉这次点击。
 */
export async function hitTestBlock(
  fromByte: number,
  toByte: number,
  page: number,
  xPt: number,
  yPt: number,
  /** 上一次 `compileBlocks` 给的几何编号（0 = 没有/旧后端 → 不校验） */
  geometryId = 0,
): Promise<number | null> {
  try {
    const out = await invoke<number | null>("block_hit_test", {
      start: fromByte,
      end: toByte,
      page,
      xPt,
      yPt,
      geometryId: geometryId > 0 ? geometryId : null,
    });
    return typeof out === "number" && Number.isFinite(out) ? out : null;
  } catch (e) {
    dbg.log("hit-test", "block_hit_test 不可用，退回块首", e);
    return null;
  }
}

/**
 * 公式渲染结果（Rust 侧 compile_math 契约，serde camelCase）。
 * svg 为「贴边 + 透明背景」的紧凑 SVG；尺寸与基线单位是 pt，
 * baselinePt = 基线到盒顶的距离（编辑器据此做 vertical-align 对齐）。
 */
export interface MathRender {
  ok: boolean;
  svg: string;
  widthPt: number;
  heightPt: number;
  baselinePt: number;
  error?: string;
}

/**
 * 公式渲染的**缺省**字号（pt）= 源码模式的正文字号：`.cm-content` 在源码模式是 14px，
 * 14 × 72 / 96 = **10.5pt**（与 Rust 侧 `typst_world::MATH_TEXT_PT` 同一口径，
 * SVG 的 pt 与编辑器 CSS 的 pt 1:1，所以两侧必须一起改）。
 *
 * **公式字号必须等于正文字号**，而写作模式的正文字号是**跟着文档走**的
 * （`compile_blocks` 的 `textPt` → `--write-doc-px`），所以写作模式下不能再用这个常数：
 * 父组件按当前文档字号传 `MathRequest.sizePt`（见 `live-preview` 的 `mathSizePt`）。
 * 曾经这里写死 12pt（= 写作模式正文 16px 那个年代的值），写作模式正文字号改成跟随文档
 * （默认 11pt）之后，光标所在块里的公式就比周围正文大 9%、也比同一公式在切片里的样子大
 * （PR #60 审查抓到）。
 */
export const MATH_TEXT_PT = 10.5;

/**
 * 渲染单个公式（编辑器内联渲染用）。失败收敛为 `{ ok: false, error }`，不抛异常
 * （调用方保持源码显示）；invoke/IPC 异常同样收敛。
 */
export async function compileMath(
  body: string,
  display: boolean,
  context: string,
  documentPath: string | null,
  sizePt: number = MATH_TEXT_PT,
  fonts?: FontConfigArgs,
): Promise<MathRender> {
  try {
    const out = await invoke<MathRender>("compile_math", {
      body,
      display,
      context,
      documentPath,
      sizePt,
      ...fontArgs(fonts),
    });
    return {
      ok: out.ok,
      svg: out.svg ?? "",
      widthPt: out.widthPt ?? 0,
      heightPt: out.heightPt ?? 0,
      baselinePt: out.baselinePt ?? 0,
      error: out.error,
    };
  } catch (e) {
    return {
      ok: false,
      svg: "",
      widthPt: 0,
      heightPt: 0,
      baselinePt: 0,
      error: e instanceof Error ? e.message : String(e),
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
