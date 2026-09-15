// 浏览器开发桩（仅开发用）：让 Typst-pad 前端能在普通浏览器里跑起来，用于开发
// 纯前端功能（编辑器交互、选区、预览排版等），不依赖 Tauri 壳与 Rust 侧编译。
//
// 启用方式：dev server 地址后加 ?browserdev=1，例如 http://localhost:1420/?browserdev=1
// 关闭方式：去掉该参数即恢复原行为（非 Tauri 环境显示"请使用桌面应用版本"提示页）。
//
// 它做两件事：
// 1. 造一个假的 window.__TAURI_INTERNALS__（让 isTauri() 为真、应用 UI 正常渲染）；
// 2. 让编译命令 compile_doc 返回**根据当前文档生成的**假 SVG 页（不调用 typst，
//    也不做真实排版），于是编辑区与预览区的交互可以完整调试。
//
// 明确不提供的能力：真实 Typst 编译、include/包解析、字体度量、PDF 导出落盘。
// 这些必须回到桌面版（Windows WebView2）验证 —— 见 CLAUDE.md 与 README。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { byteOffsetsToPositions } from "./block-offsets";
import type { Diagnostic } from "./typst-engine";

/** 是否以"浏览器开发模式"启动（?browserdev=1） */
export function isBrowserDev(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("browserdev");
}

/**
 * 假块级渲染（compile_blocks）的开关：`?browserdev=1&blocks=1` —— **只给验收脚本用**。
 *
 * 为什么默认关：块切片会把"非光标块"整块换成图片，于是写作模式下那一块里的
 * `.cm-markup-heading` / 公式 widget 等**都不再存在于 DOM**（设计如此）。既有的
 * `wysiwyg.mjs`（209 项）断言的是"标记装饰"世界，默认开着它就会整片变红、把回归信号淹掉。
 * 所以：默认关 = 走原来的公式/标记路径（既有验收的回归网原样有效），
 * 专门验块级渲染的用例走 `scripts/browser-check/writing-blocks.mjs`（带 &blocks=1）。
 */
function blocksStubEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("blocks");
}

/**
 * 注入的**真实**块级切片夹具（`npm run fixtures:blocks` 产出，验收脚本用
 * `Page.addScriptToEvaluateOnNewDocument` 放进来）——命中时桩返回真实产物，
 * 于是"切片摞起来 == 原版式"这条能在浏览器里按真实几何验（见 writing-blocks-visual.mjs）。
 */
interface BlockFixture {
  name: string;
  doc: string;
  contentWidthPt: number;
  pageWidthPt: number;
  blocks: unknown[];
}

function injectedBlockFixtures(): BlockFixture[] | null {
  if (typeof window === "undefined") return null;
  const injected = (window as unknown as Record<string, unknown>).__DEV_BLOCK_FIXTURES;
  return Array.isArray(injected) ? (injected as BlockFixture[]) : null;
}

/** 是否额外开启"假的可更新版本"（?browserdev=1&fakeupdate=1）——只给验收脚本用 */
function isFakeUpdateEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("fakeupdate");
}

// ---------------------------------------------------------------------------
// 模拟 webview 缩放（?browserdev=1&zoomsim=1）——只给验收脚本用。
//
// 真机（WebView2）上遇到过一个只在真机出现的问题：引擎没接受"放大"，而前端状态照旧涨到上限，
// 于是从 250% 往下滚要滚十几档才有反应（用户反馈「放大根本没用，缩小有用」→「最大后无法用滚轮缩小」）。
// 要在无头验收里复现，就得让 setZoom **真的有副作用**：这里给 window.devicePixelRatio 装一个
// getter，让它等于"模拟的引擎缩放 × 基准 dpr"（Chromium 的 dpr 本来就是显示器缩放 × 页面缩放），
// 页面侧的复核逻辑（+page.svelte 的 engineZoom）就能读到引擎到底接受了多少。
// `&zoomcap=1` 再模拟「引擎只肯缩小、放大一律按 100% 处理」那台机器。
// ---------------------------------------------------------------------------

/** 模拟的"显示器缩放"：故意用非整数，确保换算不是靠 1:1 蒙对的 */
const ZOOM_SIM_BASE_DPR = 1.25;

/**
 * `?browserdev=1&zoomsim=1` 的档位上限模拟：
 * - `&zoomcap=1`：引擎**只肯缩小**，放大一律按 100% 处理（最极端的那台机器）；
 * - `&zoommax=2.1`：引擎能放大，但**只到 2.1**（2026-09-14 用户报「缩放到最大后无法从
 *   Ctrl+滚轮缩小」就是这台机器的形状：状态冲过引擎上限 → 往下滚要滚十几档才有反应）；
 * - `&zoomdelay=300`：引擎**晚一拍**才把档位落到布局上（模拟"设完立刻量还是旧档位"的机器，
 *   复核的多等几次就是为它准备的，见 zoom.ts 的 ZOOM_VERIFY_WAITS_MS）。
 */
function zoomSimMode(): { sim: boolean; cap: number | null; delay: number } {
  if (typeof window === "undefined") return { sim: false, cap: null, delay: 0 };
  const params = new URLSearchParams(window.location.search);
  const sim = params.has("zoomsim");
  if (!sim) return { sim: false, cap: null, delay: 0 };
  const delayParam = Number(params.get("zoomdelay"));
  const delay = Number.isFinite(delayParam) && delayParam > 0 ? delayParam : 0;
  if (params.has("zoomcap")) return { sim: true, cap: 1, delay };
  const max = Number(params.get("zoommax"));
  return { sim: true, cap: Number.isFinite(max) && max > 0 ? max : null, delay };
}

/**
 * 装上"假引擎"：dpr = 基准 × 引擎实际接受的缩放（旧判据用的信号），
 * 并且把 **CSS 视口宽度** 也按引擎实际接受的缩放等比缩小
 * （`clientWidth = 基准宽 ÷ 缩放`）——页面现在用这个宽度比来判定"引擎到底接受了多少"
 * （见 zoom.ts 的 zoomFromWidths）。基准宽在第一次读取时取，那时浏览器没有真实缩放，
 * 量到的就是 100% 下的布局宽度。
 *
 * `delayMs > 0` 时**延迟生效**（同一时刻只保留最后一次请求，像真引擎那样把中间值合并掉）：
 * 设完之后立刻量读到的还是旧档位，过一会儿才变。
 */
function installFakeDevicePixelRatio(
  initialZoom: number,
  delayMs = 0,
  onApplied?: (zoom: number) => void,
): (zoom: number) => void {
  let applied = initialZoom;
  let baseWidth: number | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const commit = (zoom: number) => {
    applied = zoom;
    onApplied?.(zoom);
    // **真引擎改档位会连带改 `window.innerWidth`，浏览器随即派发一次 `resize`**
    // （WebView2 参考文档 get_ZoomFactor 原话："Changing zoom factor may cause
    // `window.innerWidth`, `window.innerHeight`, both, and page layout to change."）。
    // 假引擎必须照做：页面里有一条 resize → 重校 100% 基准的逻辑（rebaselineZoom），
    // 少了这次派发，验收就永远碰不到"缩放自己引发的 resize"这条路径 ——
    // 2026-09-14 用户第五次反馈「还是会出现界面缩放未生效」正是它（见 +page.svelte 的
    // zoomSettlingUntil）。
    setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
  };
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    get: () => ZOOM_SIM_BASE_DPR * applied,
  });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    get: () => {
      if (baseWidth === null) baseWidth = document.documentElement.getBoundingClientRect().width;
      return baseWidth > 0 ? baseWidth / applied : baseWidth;
    },
  });
  onApplied?.(applied);
  return (zoom: number) => {
    if (delayMs > 0) {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        commit(zoom);
      }, delayMs);
      return;
    }
    commit(zoom);
  };
}

/** 模拟引擎缩放的状态（见"模拟 webview 缩放"一节的说明） */
let zoomSimEnabled = false;
/** 模拟引擎的档位上限（null = 照单全收；见 zoomSimMode） */
let zoomSimCap: number | null = null;
let zoomSimState: ((zoom: number) => void) | null = null;

// 假的可用更新（形状与 @tauri-apps/plugin-updater 的 Update 元数据一致：
// rid / currentVersion / version / date / body）。body 就是 latest.json 的 notes，
// 即 CHANGELOG 该版本的 Markdown 原文；这里刻意混进一条 HTML 注入样本，
// 让「更新说明必须转义后渲染」这件事在验收里有断言（见 wysiwyg.mjs 第 26 组）。
const FAKE_UPDATE = {
  rid: 9001,
  currentVersion: "0.7.3",
  version: "0.7.4",
  date: new Date().toISOString(),
  body: [
    "### Fixed",
    "",
    "- **中文不再被渲染成楷体**：typst 默认正文字体不含汉字，中文全走自动回退。",
    "  - 现在由 Rust 侧注入默认字体族，`font-warnings.ts` 负责提示族名写错的情况。",
    "- <img src=x onerror=\"alert(1)\"> 这段必须原样显示成文本，不能被当标签解析。",
    "",
    "### Added",
    "",
    "- 界面缩放（Ctrl+滚轮）与正文字体设置。",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// 假 SVG 生成：把文档按行转成 SVG 文本行；行数超过一页容量就分页。
// 目的是让预览区有真实的多页结构（含 page-separator 分隔），便于调试滚动/缩放/分栏。
// 注意：这只是"看起来像排版结果"，不是 Typst 的真实输出。
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 595.28; // A4 宽（pt）
const PAGE_HEIGHT = 841.89; // A4 高（pt）
const MARGIN = 70;
const LINE_HEIGHT = 22;
const FONT_SIZE = 12;
const MAX_COLUMNS = 32; // 超出按 CJK 双宽折行
const LINES_PER_PAGE = Math.max(1, Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT));

/** XML 文本转义（拼进 SVG 前调用；不要对已转义结果二次调用） */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CJK 字符按 2 列计宽的简单折行（仅为了假预览不横向溢出，不做真实排版） */
function wrapLine(line: string): string[] {
  const lines: string[] = [];
  let current = "";
  let columns = 0;
  for (const ch of line) {
    const width = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (columns + width > MAX_COLUMNS) {
      lines.push(current);
      current = "";
      columns = 0;
    }
    current += ch;
    columns += width;
  }
  lines.push(current);
  return lines;
}

/** 文档 → 供假 SVG 渲染的行数组（空行保留为空白行，段落不丢失） */
function docToLines(doc: string): string[] {
  const out: string[] = [];
  for (const raw of doc.split("\n")) {
    if (raw.trim() === "") {
      out.push("");
      continue;
    }
    out.push(...wrapLine(raw));
  }
  if (out.length === 0) out.push("");
  return out;
}

/** 渲染单页 SVG 字符串（结构模仿 typst 的 SVG 输出：一个 svg 根 + 一组 text） */
function renderPage(
  lines: string[],
  pageIndex: number,
  pageCount: number,
  pageWidthPt: number = PAGE_WIDTH,
): string {
  // 预览重排：**纸张宽度变窄、字号不变**（这正是"重排"与"等比缩小"的区别——真实后端由
  // typst 按新页宽重排正文，`#set page(width:)` 不改 text size）。页高与边距按 A4 比例缩放
  // （与 Rust 侧 preview_page_setup 一致），行高与字号保持原值 → 窄页排下更多行、页数变多。
  const ratio = pageWidthPt / PAGE_WIDTH;
  const width = pageWidthPt;
  const height = PAGE_HEIGHT * ratio;
  const margin = MARGIN * ratio;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const y = margin + (i + 1) * LINE_HEIGHT;
    parts.push(
      `<text x="${margin}" y="${y}" font-family="Noto Serif CJK SC, Songti SC, serif" font-size="${FONT_SIZE}" fill="#111111">${escapeXml(line)}</text>`
    );
  });
  // 页脚页号：便于确认多页拼接与 page-separator 分隔生效
  parts.push(
    `<text x="${width / 2}" y="${height - margin / 2}" text-anchor="middle" font-family="Noto Serif CJK SC, serif" font-size="10" fill="#666666">${pageIndex + 1} / ${pageCount}</text>`
  );
  parts.push("</svg>");
  return parts.join("");
}

/** 注入页面的真实公式产物（见 scripts/browser-check/wysiwyg-visual.mjs 与 Rust 的 dump_math_fixtures） */
interface RealMathFixture {
  body: string;
  display: boolean;
  /** 编译字号（pt）：必须与被请求的字号一致，否则尺寸/基线都不对 */
  sizePt?: number;
  svg: string;
  widthPt: number;
  heightPt: number;
  baselinePt: number;
}

/**
 * 取注入的真实公式产物：body + 风格 + **字号** 三者都要对上（字号不同尺寸就不对，
 * 宁可退回假 SVG 也不要给出尺寸错误的"真产物"）。夹具未标字号时按旧格式放行。
 */
function realMath(body: string, display: boolean, sizePt: number): RealMathFixture | undefined {
  const list = (window as unknown as { __DEV_MATH_FIXTURES?: RealMathFixture[] })
    .__DEV_MATH_FIXTURES;
  if (!Array.isArray(list)) return undefined;
  return list.find(
    (f) =>
      f.body === body &&
      f.display === display &&
      (f.sizePt === undefined || Math.abs(f.sizePt - sizePt) < 0.01),
  );
}

/**
 * 假公式渲染：结构模仿 typst 的 compile_math 产物（贴边 viewBox + 透明底 + 文本），
 * 尺寸/基线给合理量级，用于在浏览器里验证「公式内联渲染」的布局与对齐（非真实排版）。
 */
function fakeMath(body: string, display: boolean) {
  const widthPt = Math.max(4, body.length * 5.2);
  const heightPt = display ? 16 : 7.2;
  const baselinePt = display ? 8.4 : 5.6;
  // 虚线边框 + 「dev 假渲染」标注：这个桩画的**不是** typst 排版，必须一眼看得出来，
  // 否则很容易把假产物当成真渲染去排查（实测踩过：以为公式渲染错了）。
  const svg =
    `<svg viewBox="0 0 ${widthPt} ${heightPt}" width="${widthPt}pt" height="${heightPt}pt" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0.4" y="0.4" width="${Math.max(0, widthPt - 0.8)}" height="${Math.max(0, heightPt - 0.8)}" ` +
    `fill="none" stroke="#e05555" stroke-width="0.8" stroke-dasharray="2 1.5"/>` +
    `<text x="0" y="${baselinePt}" font-size="10.5" ` +
    `font-style="italic" font-family="New Computer Modern Math, serif" fill="#000000">` +
    `${escapeXml(body)}</text></svg>`;
  return { ok: true, svg, widthPt, heightPt, baselinePt };
}

/**
 * 真产物的可用性提示：如果**真实编译未接入**（浏览器里只能假渲染），首次挂载时在控制台
 * 明确说一次，并把提示写进页面标题，避免"假排版当成真排版"。
 */
export function warnFakeRendering(): void {
  console.warn(
    "[browser-dev] 公式与整页预览都是**桩产物**（不是 typst 排版）：仅用于调 UI 与交互。\n" +
      "要看到真实排版，请用桌面版 `npm run tauri dev`。",
  );
}

/** 当前文档 → 假 SVG 页数组；pageWidthPt = 预览重排请求的页宽（缺省 A4） */
export function fakePages(doc: string, pageWidthPt?: number): string[] {
  const lines = docToLines(doc);
  // 预览重排（compile_doc 的 previewWidthPt）在假实现里也要有可见效果：页更窄 → 同一段文字
  // 排到更多页（真实后端由 typst 重排，见 typst_world::preview_page_setup）
  const width = typeof pageWidthPt === "number" && pageWidthPt > 0 ? pageWidthPt : PAGE_WIDTH;
  // 每页行数按"纸张高度（随宽度等比缩放）− 边距"算：字号与行高不变 → 窄页排得下的行更少、页数更多
  const ratio = width / PAGE_WIDTH;
  const usableHeight = PAGE_HEIGHT * ratio - 2 * MARGIN * ratio;
  const perPage = Math.max(1, Math.floor(usableHeight / LINE_HEIGHT));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) {
    pages.push(lines.slice(i, i + perPage));
  }
  if (pages.length === 0) pages.push([""]);
  return pages.map((pageLines, i) => renderPage(pageLines, i, pages.length, width));
}

// ---------------------------------------------------------------------------
// 假命令：只实现前端实际会调用的那几个（见 file-ops.ts / typst-engine.ts / +page.svelte）
// ---------------------------------------------------------------------------

/** 浏览器内存"文件系统"的假路径（write_file 记住它，read_file 能读回来） */
const FAKE_PATH = "/browser-dev/未命名.typ";
const fakeFiles = new Map<string, string>();

/** 已提示过的命令（编译每次输入都会触发，只提示一次，避免刷屏） */
const notified = new Set<string>();

/** 开发期提示：把每条假命令打出来，避免"以为在跑真编译"的误判 */
function notify(command: string): void {
  if (notified.has(command)) return;
  notified.add(command);
  console.info(`[browser-dev] 假命令 <<< ${command}（未调用真实 Rust 后端，仅首次提示）`);
}

/**
 * 假块级渲染产物（`compile_blocks` 的桩）：**不是 typst 排版**，只用来在真实浏览器里
 * 验证"块级切片"这条链路的交互（非光标块被替换、光标进入展开、点击回到源码、源码模式不受影响）。
 *
 * 切块规则与 Rust 侧 block_geometry 的"块"大致对应（空行分段、`=` 标题、`-`/`+` 列表项、
 * 围栏代码块各自成块），足以让验收脚本构造出想要的结构。真实几何由 Rust 侧负责。
 */
export function fakeBlocks(doc: string): {
  ok: true;
  blocks: {
    start: number;
    end: number;
    kind: string;
    found: boolean;
    pages: number;
    yPt: number;
    widthPt: number;
    heightPt: number;
    bands: number;
    svg: string;
  }[];
  pages: number;
  pageWidthPt: number;
} {
  const encoder = new TextEncoder();
  const lines = doc.split("\n");
  /** 行号 → 该行起始字节偏移 */
  const lineStart: number[] = [];
  let bytes = 0;
  for (const line of lines) {
    lineStart.push(bytes);
    bytes += encoder.encode(line).length + 1; // +1 = 换行
  }
  const lineEnd = (i: number) => lineStart[i] + encoder.encode(lines[i]).length;

  const out: ReturnType<typeof fakeBlocks>["blocks"] = [];
  let i = 0;
  let y = MARGIN;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const isHeading = /^=+\s/.test(line);
    const isList = /^\s*[-+]\s/.test(line);
    const isFence = line.trimStart().startsWith("```");
    let j = i;
    if (isFence) {
      j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith("```")) j++;
      if (j < lines.length) j++; // 收尾围栏
    } else if (isHeading || isList) {
      j = i + 1; // 标题/列表项：一行一块（列表不合并，便于验收精确断言）
    } else {
      // 段落：吃到空行为止
      while (j + 1 < lines.length && lines[j + 1].trim() !== "" && !/^=+\s/.test(lines[j + 1])) j++;
      j++;
    }
    const rows = j - i;
    const heightPt = rows * LINE_HEIGHT + 6;
    const kind = isHeading ? "Heading" : isList ? "ListItem" : isFence ? "Raw" : "Paragraph";
    // 假切片：与整页 SVG 同构（svg 根 + 若干 text），尺寸按块自身高度。
    // **标记要抹掉**（`= ` 标题、`- ` 列表符号、围栏、行间公式的 `$`）：真实 typst 渲染
    // 出来的就是"没有标记"的样子；验收也正是靠这一点断言"被切片盖住的块不再是源码形态"
    // （留着标记的话，切片内文本与源码文本无法区分）。
    const texts = lines
      .slice(i, j)
      .filter((t) => !t.trimStart().startsWith("```"))
      .map((raw, k) => {
        const t = raw
          .replace(/^\s*=+\s*/, "")
          .replace(/^\s*[-+]\s+/, "• ")
          .replace(/^\s*\$\s*/, "")
          .replace(/\s*\$\s*$/, "");
        const esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<text x="${MARGIN}" y="${MARGIN + (k + 1) * LINE_HEIGHT - 6}" font-size="14">${esc}</text>`;
      })
      .join("");
    const svg =
      `<svg viewBox="0 0 ${PAGE_WIDTH} ${heightPt}" width="${PAGE_WIDTH}pt" height="${heightPt}pt" ` +
      `xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>` +
      `<g data-block="${kind}">${texts}</g></svg>`;
    out.push({
      start: lineStart[i],
      end: lineEnd(j - 1),
      kind,
      found: true,
      pages: 1,
      yPt: y,
      widthPt: PAGE_WIDTH,
      heightPt,
      bands: rows,
      svg,
    });
    y += heightPt;
    i = j;
  }
  return { ok: true, blocks: out, pages: 1, pageWidthPt: PAGE_WIDTH };
}

/**
 * 浏览器开发模式下的假字体列表（设置 → 正文字体 的下拉数据源）。
 * 真实字体集由 Rust 侧 FontBook 提供（打包字体 + 系统字体 + 额外目录），浏览器里没有；
 * 这里给出与真实形状一致的数据，让验收脚本能覆盖"下拉/额外字体目录"这条 UI 链路。
 * DEFAULT 与 typst_world.rs 的 DEFAULT_FONT_FAMILIES 保持一致。
 */
const FAKE_FONT_FAMILIES = [
  "DejaVu Sans Mono",
  "Libertinus Serif",
  "Microsoft YaHei",
  "New Computer Modern Math",
  "Noto Serif CJK SC",
  "SimSun",
  "Songti SC",
  "STSong",
];
const FAKE_FONT_FAMILIES_DEFAULT = [
  "Libertinus Serif",
  "Noto Serif CJK SC",
  "SimSun",
  "Songti SC",
  "Source Han Serif SC",
  "Noto Serif SC",
  "Microsoft YaHei",
];

async function handleCommand(
  command: string,
  args: Record<string, unknown> | undefined
): Promise<unknown> {
  const a = args ?? {};
  switch (command) {
    case "compile_doc": {
      const src = typeof a.src === "string" ? a.src : "";
      notify(command);
      // 仿造一条真实存在的警告：中文族名（如 "微软雅黑"）永远匹配不上字体文件里的英文族名，
      // typst 只发 warning 后静默回退——验收要靠它验证"警告徽标 + 中文提示"这条链路。
      const warnings: Diagnostic[] = /font:\s*"[^"]*[\u4e00-\u9fff]/.test(src)
        ? [
            {
              message: "unknown font family: 微软雅黑",
              severity: "warning",
              line: 1,
              column: 1,
            },
          ]
        : [];
      // 记录最近一次 compile_doc 入参 + 调用次数：验收靠它断言「保存设置 → 立即重编译」
      // 与「字体配置确实传下去了」（假 SVG 本身看不出字体），以及「预览重排的页宽传对了」
      const w = window as unknown as Record<string, unknown>;
      w.__browserDevCompileCount = ((w.__browserDevCompileCount as number) ?? 0) + 1;
      w.__browserDevLastCompile = {
        src,
        fontFamilies: Array.isArray(a.fontFamilies) ? a.fontFamilies : null,
        fontDirs: Array.isArray(a.fontDirs) ? a.fontDirs : null,
        previewWidthPt: typeof a.previewWidthPt === "number" ? a.previewWidthPt : null,
      };
      // 预览重排：请求了页宽就让假页按它重排（页更窄 → 页数更多）。
      // `&reflowfail=1` 模拟"文档自己写了 #set page(...)"那台机器：注入被覆盖、产物页宽
      // 仍是 A4 —— 前端据此退回旧的等比缩放路径（见 preview-scale.isReflowApplied）。
      const requested = typeof a.previewWidthPt === "number" && a.previewWidthPt > 0 ? a.previewWidthPt : undefined;
      const honored = new URLSearchParams(window.location.search).has("reflowfail") ? undefined : requested;
      // 返回 Rust 侧契约的 CompileOutput 形状（见 typst-engine.ts）
      return { ok: true, pages: fakePages(src, honored), warnings };
    }
    case "compile_blocks": {
      if (!blocksStubEnabled()) return null; // 默认关：见 blocksStubEnabled 的说明
      // 写作模式的块级渲染（阶段 1）：桩只做"结构正确"的假切片，见 fakeBlocks 的说明。
      const src = typeof a.src === "string" ? a.src : "";
      const docOffset = typeof a.docOffset === "number" ? a.docOffset : 0;
      // 只取用户文档那一段（前缀不属于编辑器内容）——真实后端返回的块偏移也是文档坐标
      const docStart = byteOffsetsToPositions(src, [docOffset])[0];
      const doc = src.slice(docStart);
      // 注入了**真实产物**夹具且文档与夹具一致 → 返回真实切片（见 writing-blocks-visual.mjs）
      const fixtures = injectedBlockFixtures();
      if (fixtures) {
        const hit = fixtures.find((f) => f.doc === doc);
        if (hit) {
          notify(command);
          return { ok: true, blocks: hit.blocks, pages: 1, pageWidthPt: hit.pageWidthPt };
        }
      }
      const out = fakeBlocks(doc);
      // 窗口化：桩也要遵守（否则验收会以为"窗口过滤"没生效）
      const wantFrom = typeof a.wantFrom === "number" ? a.wantFrom : null;
      const wantTo = typeof a.wantTo === "number" ? a.wantTo : null;
      if (wantFrom !== null && wantTo !== null) {
        for (const b of out.blocks) {
          if (b.start >= wantTo || b.end < wantFrom) b.svg = "";
        }
      }
      notify(command);
      return out;
    }
    case "compile_math": {
      notify(command);
      const body = typeof a.body === "string" ? a.body : "";
      // 记录最近一次公式渲染入参（body/display/context）：浏览器端验收要靠它断言
      // "文档内 #let 定义确实进了编译上下文"这类纯前端管线行为（假 SVG 看不出上下文）
      (window as unknown as Record<string, unknown>).__browserDevLastMath = {
        body,
        display: a.display === true,
        context: typeof a.context === "string" ? a.context : "",
      };
      // 有注入的真实产物就用真实产物（浏览器里看到的是 typst 真排版，含真尺寸/真基线）。
      // 注意补 `ok: true`：夹具 json 里没有该字段，缺了会被前端当成"渲染失败"而不渲染
      // （实测踩过：页面里公式一直停在源码，看不出是夹具的问题）。
      const sizePt = typeof a.sizePt === "number" ? a.sizePt : 12;
      const real = realMath(body, a.display === true, sizePt);
      return real ? { ok: true, ...real } : fakeMath(body, a.display === true);
    }
    case "write_file": {
      const path = typeof a.path === "string" ? a.path : FAKE_PATH;
      fakeFiles.set(path, typeof a.content === "string" ? a.content : "");
      notify(command);
      return null;
    }
    case "read_file": {
      notify(command);
      return fakeFiles.get(typeof a.path === "string" ? a.path : "") ?? "";
    }
    case "export_pdf": {
      notify(command);
      return { ok: false, error: "浏览器开发模式不提供 PDF 导出（请在桌面版验证）" };
    }
    case "write_binary":
    case "list_dir_typ":
      notify(command);
      return command === "list_dir_typ" ? [] : null;
    // 字体：设置里「正文字体」下拉的选项来源 + Rust 内置默认列表
    case "list_font_families": {
      notify(command);
      const dirs = Array.isArray(a.fontDirs) ? (a.fontDirs as unknown[]) : [];
      // 加了额外字体目录时多返回一个"用户字体"，便于验收断言"加目录 → 下拉里出现新字体"
      return dirs.length > 0 ? [...FAKE_FONT_FAMILIES, "UserFont Demo"] : [...FAKE_FONT_FAMILIES];
    }
    case "default_font_families":
      notify(command);
      return [...FAKE_FONT_FAMILIES_DEFAULT];
    case "take_pending_files":
      return [];
    case "get_debug_flag":
      return false;
    // 自动更新：浏览器开发模式没有真实 updater（更没有 Rust 侧的签名校验与安装器）。
    // 返回 null = "没有可用更新"——让"启动静默检查 → 更新状态机"这条链路在验收里安静走通，
    // 而不是刷一屏未知命令。真实更新行为只能在桌面版验证（见 CLAUDE.md「测试」）。
    // 例外：`?browserdev=1&fakeupdate=1` 时返回一个**假的可用更新**，让"发现新版本"弹窗
    // （含更新说明的 Markdown 渲染）也能被验收覆盖——否则这条 UI 只有真发版时才看得到。
    // 另外**记一笔调用次数**（`window.__browserDevUpdaterChecks`）：第 34 组据此断言
    // 「关掉设置开关后启动**一次都没查**」，而不是只看"弹窗没出现"。
    // 版本号（关于弹窗用）：`getVersion()` 走的就是这条命令。给一个**明显是假的**版本，
    // 验收据此断言"弹窗里的版本号确实来自运行时"，而不是页面里硬编码的字符串。
    case "plugin:app|version":
      notify(command);
      return "0.0.0-browserdev";
    // 外部链接（关于弹窗的「项目主页」）：浏览器里没有系统浏览器可开，但**记录请求的 URL**，
    // 让验收能断言"点下去确实带着项目地址走到了 opener 插件"。
    case "plugin:opener|open_url": {
      const url = typeof a.url === "string" ? a.url : null;
      const w = window as unknown as Record<string, unknown>;
      const urls = Array.isArray(w.__browserDevOpenUrls) ? (w.__browserDevOpenUrls as unknown[]) : [];
      urls.push(url);
      w.__browserDevOpenUrls = urls;
      notify(command);
      return null;
    }
    case "plugin:updater|check": {
      notify(command);
      const w = window as unknown as Record<string, unknown>;
      w.__browserDevUpdaterChecks = (typeof w.__browserDevUpdaterChecks === "number" ? w.__browserDevUpdaterChecks : 0) + 1;
      return isFakeUpdateEnabled() ? FAKE_UPDATE : null;
    }
    // 界面缩放（Ctrl+滚轮）：浏览器开发模式没有 Tauri 的 webview 缩放，但**记录请求的系数**，
    // 让浏览器验收能断言"确实按一档 10% 请求了缩放"（真实缩放效果只能在桌面版看）。
    case "plugin:webview|set_webview_zoom": {
      const value = typeof a.value === "number" ? a.value : null;
      const w = window as unknown as Record<string, unknown>;
      w.__browserDevLastZoom = value;
      if (zoomSimState !== null && value !== null) {
        // 模拟引擎：默认照单全收；`&zoomcap=1` 时模拟"放大一律不接受"的真机
        zoomSimState(zoomSimCap === null ? value : Math.min(value, zoomSimCap));
      }
      // 调用次数：界面缩放会"设一次 + 手势停下后再确认一次"（见 +page.svelte 的
      // applyUiZoom/scheduleZoomConfirm），验收据此锁定那个兜底重试确实发出去了。
      w.__browserDevZoomCalls = (typeof w.__browserDevZoomCalls === "number" ? w.__browserDevZoomCalls : 0) + 1;
      notify(command);
      return null;
    }
    // 多窗口（Ctrl+Shift+N 新建窗口）：浏览器里没有真的多窗口，但**记录创建请求**
    // （label/title/url），让验收能断言"这个手势确实走到了创建窗口这一步、参数也对"。
    // 真实多窗口只能在桌面版验证（窗口本身、以及窗口之间的存档与 open-file 交接）。
    case "plugin:webview|create_webview_window": {
      const options = (a.options ?? {}) as Record<string, unknown>;
      const w = window as unknown as Record<string, unknown>;
      const requests = Array.isArray(w.__browserDevWindowRequests)
        ? (w.__browserDevWindowRequests as unknown[])
        : [];
      requests.push({
        label: typeof options.label === "string" ? options.label : null,
        title: typeof options.title === "string" ? options.title : null,
        url: typeof options.url === "string" ? options.url : null,
      });
      w.__browserDevWindowRequests = requests;
      notify(command);
      return null;
    }
    default:
      // dialog 插件（plugin:dialog|confirm 等）与未实现命令：给出行为安全的默认值，
      // 让 UI 不崩、也不产生"假成功"的错觉。
      notify(command);
      if (command === "plugin:dialog|confirm" || command === "plugin:dialog|ask") {
        return false;
      }
      // 目录选择器（设置 → 额外字体目录）：给一个假目录，让验收能走完"添加目录 → 刷新字体列表"。
      // 文件对话框仍返回 null（保持原有的"取消"语义，不影响文件打开/保存的验收）。
      //
      // ⚠️ 参数形状：dialog 插件的**所有选项都嵌在 `options` 里**
      // （`invoke('plugin:dialog|open', { options })`，见 @tauri-apps/plugin-dialog 的 dist-js），
      // 不是平铺在顶层。曾经按 `args.directory` 判断，于是"添加字体目录"在浏览器验收里
      // 永远拿到 null、点了没反应（第 25 组因此卡在找不到 .settings-dir-path）。
      // 两种形状都接受，避免插件升级/调用方写法变化时又静默失效。
      if (command === "plugin:dialog|open") {
        const options = (typeof a.options === "object" && a.options !== null ? a.options : a) as Record<
          string,
          unknown
        >;
        if (options.directory === true) {
          return typeof options.defaultPath === "string" ? options.defaultPath : "D:\\fake-fonts";
        }
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// 假 __TAURI_INTERNALS__
// ---------------------------------------------------------------------------

let installed = false;

/** 安装假的 __TAURI_INTERNALS__（幂等；只在浏览器开发模式下调用） */
export function installBrowserDevStub(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  if ("__TAURI_INTERNALS__" in window) return; // 真 Tauri 环境绝不覆盖
  installed = true;

  // 模拟引擎缩放的接线（见文件开头的说明）：装假 dpr + 记住"引擎接受的系数"写入口
  const simMode = zoomSimMode();
  zoomSimEnabled = simMode.sim;
  zoomSimCap = simMode.cap;
  if (simMode.sim) {
    // 初始 100%（界面启动时就是 100%，页面侧随后会校准/恢复档位）
    const engineWindow = window as unknown as Record<string, unknown>;
    const applySimulatedZoom = installFakeDevicePixelRatio(1, simMode.delay, (zoom) => {
      engineWindow.__browserDevEngineZoom = zoom;
    });
    zoomSimState = (zoom: number) => applySimulatedZoom(zoom);
  }

  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextCallbackId = 1;

  const internals = {
    // Tauri 2 的 JS API 走这个入口（见 node_modules/@tauri-apps/api/core.js）
    invoke: (command: string, args?: Record<string, unknown>) => handleCommand(command, args),
    // 事件系统（@tauri-apps/api/event）依赖的方法：注册回调并返回 id
    transformCallback: (callback?: (payload: unknown) => void, once = false): number => {
      const id = nextCallbackId++;
      if (typeof callback === "function") {
        callbacks.set(id, (payload: unknown) => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
      }
      return id;
    },
    unregisterCallback: (id: number): void => {
      callbacks.delete(id);
    },
    convertFileSrc: (filePath: string): string => filePath,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
      currentWebviewWindow: { label: "main" },
    },
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  // 标记桩已生效。`fakeZoom: true` = 这里的 setZoom **没有真实副作用**（页面据此跳过缩放复核，
  // 否则会误报"缩放未生效"）；开了 zoomsim（假 dpr）时副作用是模拟出来的，复核要照常跑。
  // 用标记而不是 import：桩是 dev-only 模块，页面 import 它会把桩打进生产包。
  (window as unknown as Record<string, unknown>).__browserDevStub = {
    fakeZoom: !zoomSimEnabled,
  };

  // 开发信息：确认桩已生效
  console.info(
    "[browser-dev] 浏览器开发模式已启用：__TAURI_INTERNALS__ 为假实现，预览来自假 SVG。"
  );
  warnFakeRendering();
  console.info(`[browser-dev] @tauri-apps/api 的 invoke 类型：${typeof tauriInvoke}`);
}
