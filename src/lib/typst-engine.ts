// Typst 编译引擎：WASM 编译器 + 本地字体 + SVG/PDF 输出（单例懒加载）。
import {
  createTypstCompiler,
  createTypstRenderer,
  createTypstFontBuilder,
} from "@myriaddreamin/typst.ts";
import {
  initOptions,
  MemoryAccessModel,
  FetchPackageRegistry,
} from "@myriaddreamin/typst.ts";
import { CompileFormatEnum } from "@myriaddreamin/typst.ts/compiler";
import type { TypstCompiler, TypstRenderer } from "@myriaddreamin/typst.ts";
import { sanitizeSvg } from "./svg-sanitize";
import { paginateSvg } from "./svg-paginate";
import { parseDiagnosticRange } from "./diagnostics-utils";
import { mark } from "./startup-timing";
// 静态导入 wasm 包装模块 + wasm URL，通过 getWrapper/getModule 显式注入，
// 绕开 typst.ts 内部的动态 import()——该动态导入在 Vite dev 预构建下会触发
// "Cannot import wasm module without importer" 错误。
import * as typstCompilerModule from "@myriaddreamin/typst-ts-web-compiler";
import * as typstRendererModule from "@myriaddreamin/typst-ts-renderer";
import compilerWasmUrl from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url";
import rendererWasmUrl from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url";

const MAIN_PATH = "/main.typ";

// 打包在 static/fonts/ 的本地字体（离线可用，无需 CDN）
const FONT_URLS = [
  "/fonts/NotoSerifCJKsc-Regular.otf",
  "/fonts/NewCMMath-Regular.otf",
  "/fonts/NewCMMath-Bold.otf",
  "/fonts/NewCMMath-Book.otf",
  "/fonts/LibertinusSerif-Regular.otf",
  "/fonts/LibertinusSerif-Bold.otf",
  "/fonts/DejaVuSansMono.ttf",
];

let compiler: TypstCompiler | null = null;
let renderer: TypstRenderer | null = null;
let initPromise: Promise<void> | null = null;

// 单飞互斥：同一时刻只允许一个编译任务在跑（compiler 单例共享 addSource/compile）
let queueTail: Promise<unknown> = Promise.resolve();

export interface CompileOk {
  ok: true;
  svg: string;
  pageCount: number;
}

/** 编译错误的源码位置（1-based 行列，parseDiagnosticRange 已从 0-based 转换），供编辑器画波浪线 / hover 提示 */
export interface CompileErrorLocation {
  message: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** 诊断来源文件的虚拟路径（"/main.typ"；本地库等为各自路径，编辑器不为其画波浪线） */
  path?: string;
}

export interface CompileFail {
  ok: false;
  error: string;
  /** 所有可定位的编译错误（含位置）；无法解析出 range 的错误会被跳过 */
  errors: CompileErrorLocation[];
}

export type CompileResult = CompileOk | CompileFail;

/** 懒加载初始化编译器/渲染器/字体；失败后允许下次重试 */
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit().catch((e) => {
      initPromise = null; // 初始化失败后允许重试
      throw e;
    });
  }
  return initPromise;
}

async function doInit(): Promise<void> {
  mark("engine-init-start");
  compiler = createTypstCompiler();
  renderer = createTypstRenderer();
  // 注入 access model 与 package registry，让 WASM 侧使用真实文件系统/联网包注册表
  // （否则是 Dummy Registry / Dummy AccessModel，#import "@preview/..." 与本地 .typ 都会抛错）
  const accessModel = new MemoryAccessModel();
  const packageRegistry = new FetchPackageRegistry(accessModel);
  mark("compiler-init-start");
  await compiler.init({
    getWrapper: () => Promise.resolve(typstCompilerModule),
    getModule: () => compilerWasmUrl,
    beforeBuild: [
      initOptions.withAccessModel(accessModel),
      initOptions.withPackageRegistry(packageRegistry),
    ],
  });
  mark("compiler-init-end");
  mark("renderer-init-start");
  await renderer.init({
    getWrapper: () => Promise.resolve(typstRendererModule),
    getModule: () => rendererWasmUrl,
  });
  mark("renderer-init-end");

  // 注：不能用 loadFonts 传 Uint8Array（0.8.0-rc3 有 bug，且数学字体不生效），
  // 需用 fontBuilder.addFontData + setFonts 显式注册。fontBuilder 同样需
  // 显式提供 wasm（无参 init 会走动态 import 触发 wasm 导入错误）。
  const builder = createTypstFontBuilder();
  mark("fontbuilder-init-start");
  await builder.init({
    getWrapper: () => Promise.resolve(typstCompilerModule),
    getModule: () => compilerWasmUrl,
  });
  mark("fontbuilder-init-end");
  // 下载与注册拆成两个阶段打点（下载阶段 → 注册阶段），便于观测各自耗时；
  // 两阶段均保持原有顺序语义。
  mark("fonts-download-start");
  const fontBufs: Uint8Array[] = [];
  for (const url of FONT_URLS) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`字体加载失败: ${url} (${res.status})`);
    }
    fontBufs.push(new Uint8Array(await res.arrayBuffer()));
  }
  mark("fonts-download-end");
  mark("fonts-register-start");
  for (const buf of fontBufs) {
    await builder.addFontData(buf);
  }
  mark("fonts-register-end");
  await builder.build(async (fonts) => {
    compiler!.setFonts(fonts);
  });
  mark("engine-init-end");
}

/** 串行化编译任务，避免并发 addSource 互相覆盖 */
export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => undefined);
  return run;
}

/**
 * 注册当前文档目录下的本地 .typ 库文件。keys 为相对虚拟路径（斜杠分隔、无前导斜杠，
 * 如 "lib.typ"、"chapters/a.typ"），values 为文件文本内容。先 resetShadow（清掉
 * main 的 shadow——但每次 compileToSvg/compileToPdf 都会先 addSource(MAIN_PATH)，
 * 所以安全），再逐个 addSource("/" + rel)。空对象也用于清理上一份文档遗留的库文件。
 */
export function registerLocalLibraries(
  files: Record<string, string>,
): Promise<void> {
  return enqueue(async () => {
    await ensureInit();
    compiler!.resetShadow();
    for (const [rel, content] of Object.entries(files)) {
      compiler!.addSource("/" + rel, content);
    }
  });
}

interface DiagnosticMessage {
  severity: string;
  message: string;
  range?: string;
  path?: string;
}

/** 编译 Typst 源码并渲染为 SVG */
export function compileToSvg(source: string): Promise<CompileResult> {
  return enqueue(async () => {
    try {
      await ensureInit();
      compiler!.addSource(MAIN_PATH, source);
      const { result, diagnostics } = await compiler!.compile({
        mainFilePath: MAIN_PATH,
        format: CompileFormatEnum.vector,
        diagnostics: "full",
      });

      const errors = (diagnostics ?? []).filter((d) => d.severity === "error");
      if (errors.length > 0) {
        return {
          ok: false,
          error: formatDiagnostic(errors[0]),
          errors: collectErrorLocations(errors),
        };
      }
      if (!result) {
        return { ok: false, error: "编译失败：未生成产物", errors: [] };
      }

      const svg = await renderer!.renderSvg({
        format: "vector",
        artifactContent: result,
        // 关闭 JS 交互层：typst-ts 默认输出内嵌未正确转义的 JS（裸 & 导致 XML 解析失败），
        // 且纯预览不需要交互脚本
        data_selection: { body: true, defs: true, css: true, js: false },
      });
      const pageCount = (svg.match(/class="typst-page"/g) ?? []).length;
      // 净化后插入页间分隔线（pageCount 仍基于原始 svg 统计，见 svg-paginate.ts）
      return { ok: true, svg: paginateSvg(sanitizeSvg(svg)), pageCount };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errors: [],
      };
    }
  });
}

function formatDiagnostic(d: DiagnosticMessage): string {
  const loc = d.range ? ` (${d.range})` : "";
  return `${d.message}${loc}`;
}

/** 把所有 error 级诊断转成带源码位置的错误列表（无法定位的跳过） */
function collectErrorLocations(
  diagnostics: DiagnosticMessage[],
): CompileErrorLocation[] {
  const locations: CompileErrorLocation[] = [];
  for (const d of diagnostics) {
    const loc = d.range ? parseDiagnosticRange(d.range) : null;
    if (loc) locations.push({ message: d.message, path: d.path, ...loc });
  }
  return locations;
}

/** 编译为 PDF 字节并返回 Blob（供下载/保存） */
export function compileToPdf(source: string): Promise<Blob> {
  return enqueue(async () => {
    await ensureInit();
    compiler!.addSource(MAIN_PATH, source);
    const { result, diagnostics } = await compiler!.compile({
      mainFilePath: MAIN_PATH,
      format: CompileFormatEnum.pdf,
      diagnostics: "full",
    });
    const errors = (diagnostics ?? []).filter((d) => d.severity === "error");
    if (errors.length > 0) {
      throw new Error(formatDiagnostic(errors[0]));
    }
    if (!result) {
      throw new Error("PDF 导出失败：未生成产物");
    }
    return new Blob([result], { type: "application/pdf" });
  });
}

// 净化逻辑见 src/lib/svg-sanitize.ts（独立模块便于单元测试）
