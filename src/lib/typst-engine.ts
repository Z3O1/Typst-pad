// Typst 编译引擎：WASM 编译器 + 本地字体 + SVG/PDF 输出（单例懒加载）。
import {
  createTypstCompiler,
  createTypstRenderer,
  createTypstFontBuilder,
} from "@myriaddreamin/typst.ts";
import { CompileFormatEnum } from "@myriaddreamin/typst.ts/compiler";
import type { TypstCompiler, TypstRenderer } from "@myriaddreamin/typst.ts";
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

export interface CompileFail {
  ok: false;
  error: string;
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
  compiler = createTypstCompiler();
  renderer = createTypstRenderer();
  await compiler.init({
    getWrapper: () => Promise.resolve(typstCompilerModule),
    getModule: () => compilerWasmUrl,
  });
  await renderer.init({
    getWrapper: () => Promise.resolve(typstRendererModule),
    getModule: () => rendererWasmUrl,
  });

  // 注：不能用 loadFonts 传 Uint8Array（0.8.0-rc3 有 bug，且数学字体不生效），
  // 需用 fontBuilder.addFontData + setFonts 显式注册。fontBuilder 同样需
  // 显式提供 wasm（无参 init 会走动态 import 触发 wasm 导入错误）。
  const builder = createTypstFontBuilder();
  await builder.init({
    getWrapper: () => Promise.resolve(typstCompilerModule),
    getModule: () => compilerWasmUrl,
  });
  for (const url of FONT_URLS) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`字体加载失败: ${url} (${res.status})`);
    }
    const buf = await res.arrayBuffer();
    await builder.addFontData(new Uint8Array(buf));
  }
  await builder.build(async (fonts) => {
    compiler!.setFonts(fonts);
  });
}

/** 串行化编译任务，避免并发 addSource 互相覆盖 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => undefined);
  return run;
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
        return { ok: false, error: formatDiagnostic(errors[0]) };
      }
      if (!result) {
        return { ok: false, error: "编译失败：未生成产物" };
      }

      const svg = await renderer!.renderSvg({
        format: "vector",
        artifactContent: result,
        // 关闭 JS 交互层：typst-ts 默认输出内嵌未正确转义的 JS（裸 & 导致 XML 解析失败），
        // 且纯预览不需要交互脚本
        data_selection: { body: true, defs: true, css: true, js: false },
      });
      const pageCount = (svg.match(/class="typst-page"/g) ?? []).length;
      return { ok: true, svg: sanitizeSvg(svg), pageCount };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

function formatDiagnostic(d: DiagnosticMessage): string {
  const loc = d.range ? ` (${d.range})` : "";
  return `${d.message}${loc}`;
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

// ---------------------------------------------------------------------------
// SVG 净化：Typst 编译产物可含用户可控的链接/图片地址（如 #link），
// 在注入 innerHTML 前移除事件属性与 javascript:/data: 协议 URL。
// ---------------------------------------------------------------------------
/** 严格解析 SVG；失败时先修复未转义的裸 & 再试一次（XML 要求 & 必须转义） */
function parseSvgStrict(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (!doc.querySelector("parsererror")) return doc;
  const fixed = svg.replace(
    /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g,
    "&amp;",
  );
  const doc2 = new DOMParser().parseFromString(fixed, "image/svg+xml");
  if (doc2.querySelector("parsererror")) {
    throw new Error("SVG 解析失败，已阻止注入");
  }
  return doc2;
}

const URL_ATTRS = ["href", "xlink:href", "src"];

// 链接协议白名单（<a href>/xlink:href）；相对 URL 与锚点（#...）放行
const ALLOWED_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];
// 图片 data URI 仅允许光栅格式（data:image/svg+xml 可含脚本，不放行）
const ALLOWED_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)([;,])/;

/** 判断 URL 属性值是否安全：协议白名单 + 相对/锚点 + 光栅 data:image 例外 */
function isSafeUrl(value: string): boolean {
  const v = value.replace(/\s+/g, "").toLowerCase();
  if (ALLOWED_DATA_IMAGE.test(v)) return true;
  // 无协议前缀 = 相对 URL 或锚点
  if (!/^[a-z][a-z0-9+.-]*:/.test(v)) return true;
  return ALLOWED_LINK_PROTOCOLS.some((p) => v.startsWith(p));
}

function sanitizeSvg(svg: string): string {
  const doc = parseSvgStrict(svg);
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  // 先收集再移除：遍历中直接 remove() 会中断 TreeWalker 游标（jsdom 行为差异）
  const toRemove: Element[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    // 移除全部事件处理属性（on*，覆盖 onclick/onpointer*/onwheel 等）
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    // 移除可执行内容元素（typst 输出不使用这些）
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "foreignobject") {
      toRemove.push(el);
    }
  }
  for (const el of toRemove) el.remove();
  return new XMLSerializer().serializeToString(doc);
}
