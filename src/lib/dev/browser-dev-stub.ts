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
// 这些必须回到桌面版（Windows WebView2）验证 —— 见 docs/development/testing.md。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { Diagnostic } from "../core/typst-engine";
import type { PreviewPage } from "../core/preview-scale";
// 假产物生成器按职责分在 `browser-dev-stub/` 下（本文件只留：开关 + 命令路由 + 安装）：
//   fake-layout —— 假整页 SVG（分页/折行/正文字号）
import { fakePages, warnFakeRendering } from "./browser-dev-stub/fake-layout";

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
function zoomSimMode(): {
  sim: boolean;
  cap: number | null;
  delay: number;
  widthStuck: boolean;
  blind: boolean;
} {
  if (typeof window === "undefined") {
    return { sim: false, cap: null, delay: 0, widthStuck: false, blind: false };
  }
  const params = new URLSearchParams(window.location.search);
  const sim = params.has("zoomsim");
  if (!sim) return { sim: false, cap: null, delay: 0, widthStuck: false, blind: false };
  const delayParam = Number(params.get("zoomdelay"));
  const delay = Number.isFinite(delayParam) && delayParam > 0 ? delayParam : 0;
  // `&zoomwidthstuck=1`：**dpr 跟着引擎缩放走，但 CSS 视口宽度不动**（2026-09-16 加的机器）。
  // 用户第六轮反馈「改变窗口大小的时候会动缩放；用 Ctrl+滚轮会回退」时的形状：状态栏那句
  // 「布局宽度没变（1379px）」说明宽度判据在这台机器上读不出缩放，而界面其实是变了的 ——
  // 只认宽度判据就会把**真的生效了**的缩放判成失败并弹回原档（见 zoom.ts 的 zoomAcceptedByTwoJudges）。
  const widthStuck = params.has("zoomwidthstuck");
  // `&zoomblind=1`：**两条判据都是瞎的**（宽度不动、dpr 也不动），但引擎其实照常缩放。
  // 这是用户那台机器的形状：截图里「布局宽度没变（1379px）」与「dpr 1.50」两条都没动，
  // 而界面其实是变了的（他说「会回退」＝先变过又被打回来）。页面侧靠"判据能力探针"识别这种机器。
  const blind = params.has("zoomblind");
  if (params.has("zoomcap"))
    return { sim: true, cap: 1, delay, widthStuck: widthStuck || blind, blind };
  const max = Number(params.get("zoommax"));
  return {
    sim: true,
    cap: Number.isFinite(max) && max > 0 ? max : null,
    delay,
    widthStuck: widthStuck || blind,
    blind,
  };
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
  widthStuck = false,
  blind = false,
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
    // blind：dpr 也不跟随缩放（真机上 dpr 只反映显示器缩放，与 WebView2 的 ZoomFactor 无关）
    get: () => ZOOM_SIM_BASE_DPR * (blind ? 1 : applied),
  });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    get: () => {
      // CSS 视口宽度 = 真实视口 ÷ 引擎缩放。用 `window.innerWidth`（没被我们改过）当"真实视口"，
      // 这样**用户拖窗口**时这个假宽度也会跟着变（重要的保真度：只按第一次读到的固定基准算的话，
      // 验收永远模拟不出"用户一边缩放一边拖窗口"这条路径，而那正是"状态栏百分比自己变"的现场）。
      const realWidth = window.innerWidth;
      if (baseWidth === null) baseWidth = document.documentElement.getBoundingClientRect().width;
      if (!(realWidth > 0)) return baseWidth;
      // widthStuck（&zoomwidthstuck=1）：宽度**永远等于 100% 基准**，模拟"宽度判据在这台机器上
      // 读不出缩放"（真机上那句「布局宽度没变（1379px）」）；dpr 照旧跟着引擎走。
      if (widthStuck) return realWidth;
      return realWidth / applied;
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
    '- <img src=x onerror="alert(1)"> 这段必须原样显示成文本，不能被当标签解析。',
    "",
    "### Added",
    "",
    "- 界面缩放（Ctrl+滚轮）与正文字体设置。",
  ].join("\n"),
};

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
 * 浏览器开发模式下的假字体列表（设置 → 正文字体 的下拉数据源）。
 * 真实字体集由 Rust 侧 FontBook 提供（打包字体 + 系统字体 + 额外目录），浏览器里没有；
 * 这里给出与真实形状一致的数据，让验收脚本能覆盖"下拉/额外字体目录"这条 UI 链路。
 * DEFAULT 与 typst_world/fonts.rs 的 DEFAULT_FONT_FAMILIES 保持一致。
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

/** 验收用慢编译/命中，模拟旧产物与新源码并存的窗口。 */
function compileSlowEnabled(): boolean {
  return (
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("compileslow")
  );
}
const SLOW_COMPILE_MS = 350;

// ---------------------------------------------------------------------------
interface PageFixture {
  doc: string;
  pages: string[];
  carets: import("../core/typst-engine").DocumentCaret[];
  cursorQueries?: { offset: number; caret: import("../core/typst-engine").DocumentCaret | null }[];
  selectionQuads?: import("../core/typst-engine").DocumentSelectionQuad[];
  whitespaceHits?: {
    page: number;
    xPt: number;
    yPt: number;
    caret: import("../core/typst-engine").DocumentCaret | null;
  }[];
  brokenDoc?: string | null;
  diagnostics?: Diagnostic[] | null;
}
let pageSnapshot: { id: number; fixture: PageFixture } | null = null;
let pageGeometrySeq = 0;
function pageFixtures(): PageFixture[] {
  return (window as unknown as { __typstPageFixtures?: PageFixture[] }).__typstPageFixtures ?? [];
}

/**
 * 每个假命令被调了多少次（只给验收脚本看，`window.__browserDevCallCounts`）。
 *
 * 报告 T3 的两条断言在 DOM 上看不出来："合成期间**零次**新的后台块编译"、"连续 8 次编辑
 * 只落 **1~2 次** `compile_blocks`"—— 只能数调用次数。
 */
function countCall(command: string): void {
  if (typeof window === "undefined") return;
  const host = window as unknown as Record<string, Record<string, number>>;
  const counts = (host.__browserDevCallCounts ??= {});
  counts[command] = (counts[command] ?? 0) + 1;
}

/** `compile_doc` 的预览重排几何（`previewPage`）：脏值当作没请求 */
function previewPageArg(value: unknown): PreviewPage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const page = value as Record<string, unknown>;
  const widthPt = Number(page.widthPt);
  const heightPt = Number(page.heightPt);
  const marginPt = Number(page.marginPt);
  if (![widthPt, heightPt, marginPt].every((v) => Number.isFinite(v) && v > 0)) return undefined;
  return { widthPt, heightPt, marginPt };
}

async function handleCommand(
  command: string,
  args: Record<string, unknown> | undefined,
): Promise<unknown> {
  const a = args ?? {};
  countCall(command);
  if (
    compileSlowEnabled() &&
    // 命中也放慢，以便验收编辑/换文档时作废在途交互。
    (command === "compile_doc" ||
      command === "document_hit_test" ||
      command === "document_cursor" ||
      command === "document_selection")
  ) {
    await new Promise((r) => setTimeout(r, SLOW_COMPILE_MS));
  }
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
      // 与「字体配置与文档路径确实传下去了」（假 SVG 本身看不出字体）。
      const w = window as unknown as Record<string, unknown>;
      w.__browserDevCompileCount = ((w.__browserDevCompileCount as number) ?? 0) + 1;
      w.__browserDevLastCompile = {
        src,
        fontFamilies: Array.isArray(a.fontFamilies) ? a.fontFamilies : null,
        fontDirs: Array.isArray(a.fontDirs) ? a.fontDirs : null,
        documentPath: typeof a.documentPath === "string" ? a.documentPath : null,
        knownPages: Array.isArray(a.knownPages) ? a.knownPages : null,
        previewPage: previewPageArg(a.previewPage) ?? null,
      };
      // 恢复夹具的失败诊断与成功 SVG 都来自原生编译，桩不模拟错误范围或排版。
      const brokenFixture = pageFixtures().find((fixture) => fixture.brokenDoc === src);
      if (brokenFixture) return { ok: false, diagnostics: brokenFixture.diagnostics };
      // 假编译错误：文档里出现标记 `DIAG-ERROR-MARKER` 时返回一条**主源错误诊断**，
      // 专门给验收锁住"编译错误必须在编辑器里画红波浪线"这条链路。
      // **故意发 `path: null`**：那是 Rust 0.4.0~0.8.2 的真实写法，前端的判据必须容忍它
      // （曾经只认 undefined/""，于是桌面版从 0.4.0 起一条波浪线都不画 —— 桩过去干脆不发
      // path 字段，所以浏览器验收一直抓不到，2026-09-18 才查出来）。Rust 侧现在改成
      // "主源不带 path 键"，那条由 typst_world/tests.rs 的序列化单测锁。
      const external = src.includes("DIAG-EXTERNAL-ERROR-MARKER");
      const marker = external ? "DIAG-EXTERNAL-ERROR-MARKER" : "DIAG-ERROR-MARKER";
      const at = src.indexOf(marker);
      if (at >= 0) {
        const before = src.slice(0, at);
        const line = before.split("\n").length;
        const column = [...before.slice(before.lastIndexOf("\n") + 1)].length + 1;
        return {
          ok: false,
          diagnostics: [
            {
              message: "模拟编译错误：这一行是为了验收红波浪线",
              severity: "error",
              line,
              column,
              endLine: line,
              endColumn: column + marker.length,
              path: external ? "broken.typ" : null,
            },
          ],
        };
      }
      // 返回 Rust 侧契约的 CompileOutput 形状（见 typst-engine.ts）
      const fixture = pageFixtures().find((f) => f.doc === src);
      pageSnapshot = fixture ? { id: ++pageGeometrySeq, fixture } : null;
      // 预览重排：桩照实按请求的纸型重排假产物（窄页 → 折行更窄、页数更多）。真实夹具
      // 不重排（它有自己的纸型）—— 那正是前端 `isReflowApplied` 要退回等比缩放的情形。
      // `&reflowfail=1` 模拟"文档把纸型写在别处、注入被覆盖"：产物仍是默认 A4。
      const requested = previewPageArg(a.previewPage);
      const honored = new URLSearchParams(window.location.search).has("reflowfail")
        ? undefined
        : requested;
      const pages = fixture?.pages ?? fakePages(src, honored);
      w.__browserDevLastPages = pages;
      // 仅验证前端差量协议；产品指纹来自 Rust Page，这里的静态夹具使用 WebCrypto。
      const pageKeys = await Promise.all(
        pages.map(async (page) => {
          const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(page));
          return (
            "stub:" +
            [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
          );
        }),
      );
      const known = Array.isArray(a.knownPages) ? a.knownPages : [];
      const output = pages.map((page, index) => (known[index] === pageKeys[index] ? null : page));
      w.__browserDevLastPagePayload = {
        sent: output.filter((page) => page !== null).length,
        reused: output.filter((page) => page === null).length,
      };
      return { ok: true, pages: output, pageKeys, geometryId: pageSnapshot?.id ?? 0, warnings };
    }
    case "document_hit_test": {
      notify(command);
      if (!pageSnapshot || a.geometryId !== pageSnapshot.id) return null;
      // 空白点击消费 Rust 导出的真实命中结果，不用最近探针模拟行尾偏移。
      // MouseEvent 的 CSS 像素坐标会取整，给夹具匹配留 1pt 容差。
      const whitespaceHit = pageSnapshot.fixture.whitespaceHits?.find(
        (p) =>
          p.page === a.page &&
          Math.abs(p.xPt - Number(a.xPt)) < 1 &&
          Math.abs(p.yPt - Number(a.yPt)) < 1,
      );
      if (whitespaceHit) return whitespaceHit.caret;
      const points = pageSnapshot.fixture.carets.filter((p) => p.page === a.page);
      return (
        points.sort(
          (p, q) =>
            Math.hypot(p.xPt - Number(a.xPt), p.yPt - Number(a.yPt)) -
            Math.hypot(q.xPt - Number(a.xPt), q.yPt - Number(a.yPt)),
        )[0] ?? null
      );
    }
    case "document_cursor": {
      notify(command);
      if (!pageSnapshot || a.geometryId !== pageSnapshot.id) return null;
      if (pageSnapshot.fixture.cursorQueries)
        return (
          pageSnapshot.fixture.cursorQueries.find((query) => query.offset === a.offset)?.caret ??
          null
        );
      return pageSnapshot.fixture.carets.find((p) => p.offset === a.offset) ?? null;
    }
    case "document_selection": {
      notify(command);
      if (!pageSnapshot || a.geometryId !== pageSnapshot.id) return [];
      const from = Math.min(Number(a.from), Number(a.to));
      const to = Math.max(Number(a.from), Number(a.to));
      if (from === to) return [];
      return (
        pageSnapshot.fixture.selectionQuads?.filter((quad) => quad.from < to && quad.to > from) ??
        []
      );
    }
    case "write_file": {
      const path = typeof a.path === "string" ? a.path : FAKE_PATH;
      const content = typeof a.content === "string" ? a.content : "";
      fakeFiles.set(path, content);
      // 每次写盘都留一条记录（含空内容）：验收据此断言"该写的写了 / 不该写的没写"。
      // 用户 2026-09-16 问「编辑器会清空文件吗」—— 验收第 38 组靠它证明整个编辑过程里一次写盘都没有。
      const w = window as unknown as Record<string, unknown>;
      const writes = Array.isArray(w.__browserDevWrites)
        ? (w.__browserDevWrites as Array<{ path: string; content: string }>)
        : [];
      writes.push({ path, content });
      w.__browserDevWrites = writes;
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
    // 而不是刷一屏未知命令。真实更新行为只能在桌面版验证（见 docs/development/testing.md）。
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
      const urls = Array.isArray(w.__browserDevOpenUrls)
        ? (w.__browserDevOpenUrls as unknown[])
        : [];
      urls.push(url);
      w.__browserDevOpenUrls = urls;
      notify(command);
      return null;
    }
    case "plugin:updater|check": {
      notify(command);
      const w = window as unknown as Record<string, unknown>;
      w.__browserDevUpdaterChecks =
        (typeof w.__browserDevUpdaterChecks === "number" ? w.__browserDevUpdaterChecks : 0) + 1;
      return isFakeUpdateEnabled() ? FAKE_UPDATE : null;
    }
    case "plugin:window|set_title":
      (window as unknown as { __browserDevLastTitle?: unknown }).__browserDevLastTitle = a.value;
      return null;
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
      w.__browserDevZoomCalls =
        (typeof w.__browserDevZoomCalls === "number" ? w.__browserDevZoomCalls : 0) + 1;
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
        return (
          (window as unknown as { __browserDevConfirm?: boolean }).__browserDevConfirm === true
        );
      }
      if (command === "plugin:dialog|message") {
        return (window as unknown as { __browserDevConfirm?: boolean }).__browserDevConfirm === true
          ? "Ok"
          : "Cancel";
      }
      if (command === "plugin:dialog|save") {
        return (
          (window as unknown as { __browserDevSavePath?: string }).__browserDevSavePath ?? null
        );
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
        const options = (
          typeof a.options === "object" && a.options !== null ? a.options : a
        ) as Record<string, unknown>;
        if (options.directory === true) {
          return typeof options.defaultPath === "string" ? options.defaultPath : "D:\\fake-fonts";
        }
        return (
          (window as unknown as { __browserDevOpenPath?: string }).__browserDevOpenPath ?? null
        );
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// 假剪贴板（验收第 44 组用）
//
// 无头 Chrome 里没有可信的系统剪贴板，`document.execCommand("copy")` 的返回值不可靠。
// 这里包一层 execCommand：copy 时把**真正被选中的那段文本**记进 `window.__browserDevCopied`
// （数组，按调用顺序），并**返回 true 当作成功** —— 这样走了生产代码的主路径（临时 textarea
// + execCommand），验收也能断言"到底往剪贴板塞了什么字符串"，而不是只看状态栏文案。
// 其余命令原样透传，不影响编辑器自己的 cut/paste。
// ---------------------------------------------------------------------------
function installFakeClipboard(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__browserDevClipboardInstalled) return;
  w.__browserDevClipboardInstalled = true;
  w.__browserDevCopied = [];

  const original = document.execCommand.bind(document);
  document.execCommand = ((commandId: string, showUi?: boolean, value?: string) => {
    if (commandId !== "copy") return original(commandId, showUi, value);
    const active = document.activeElement;
    let text =
      active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
        ? active.value
        : (window.getSelection()?.toString() ?? "");
    if (active instanceof HTMLElement && active.closest(".cm-editor")) {
      // 透明输入层的 DOM 选区可能只含可见片段；必须走 CM 原生 copy 处理器，
      // 由它序列化真实源码选区，而不是绕过事件误复制 DOM 文本。
      const data = new DataTransfer();
      const event = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      active.dispatchEvent(event);
      if (event.defaultPrevented) text = data.getData("text/plain");
    }
    const copied = w.__browserDevCopied as string[];
    copied.push(text);
    console.info(`[browser-dev] 假剪贴板：已"复制" ${text.length} 字符`);
    return true;
  }) as typeof document.execCommand;
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
    const applySimulatedZoom = installFakeDevicePixelRatio(
      1,
      simMode.delay,
      (zoom) => {
        engineWindow.__browserDevEngineZoom = zoom;
      },
      simMode.widthStuck,
      simMode.blind,
    );
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

  installFakeClipboard();

  // 开发信息：确认桩已生效
  console.info(
    "[browser-dev] 浏览器开发模式已启用：__TAURI_INTERNALS__ 为假实现，预览来自假 SVG。",
  );
  warnFakeRendering();
  console.info(`[browser-dev] @tauri-apps/api 的 invoke 类型：${typeof tauriInvoke}`);
}
