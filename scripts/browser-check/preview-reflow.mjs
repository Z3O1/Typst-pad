// **预览重排守卫**：纸张跟着预览栏走 —— 栏宽/模式变化时页面按新宽度重新排版，预览栏
// 永不出现横向滚动条，而且预览字号恒等于编辑区字号（11pt 正文 ↔ 14px）。
//
// 用户口径（2026-10-08）：「直接把纸张大小改小，且不滚动，可以接受排版变化。」
// 前史：2026-09-14 起过一版（插在编译源最前面 → 被文档自己的 `#set page` 覆盖，真实文档
// 永远拿不到重排），2026-10-08 重做成"插在文档自己的页面设置之后"（Rust 侧）并与兜底等比
// 缩放整条打通。本套件锁住前端这一侧：**永不横滚 + 字号与代码一致 + 请求真的生效**。
//
// 这套用假产物（不注入真实夹具）：桩会按请求的纸型重新折行/分页，于是"重排生效"在 DOM 上
// 看得见；把查询串换成 `&reflowfail=1`（不用重启页面，桩是每次编译时读它）模拟"文档把纸型
// 写在别处、注入被覆盖"，必须退回等比缩放。

import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep } from "./harness.mjs";

const { check, state } = createChecker();
const c = await connect();

/** 等编译次数稳定：重排是"先编译学文档纸型 → 再按栏宽重编译"两步 */
async function settledCompiles() {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const count = await c.evaluate("window.__browserDevCompileCount ?? 0");
    if (count === last && count > 0) return count;
    last = count;
    await sleep(200);
  }
  return last;
}

async function viewport(width, height = 900) {
  await c.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(150);
  await settledCompiles();
}

/** 量预览：栏宽、横向溢出、纸宽、产物页宽（pt）、预览字号（px）、请求页宽（pt） */
const measured = () =>
  c.evaluate(`(() => {
    const body = document.querySelector('.preview-body');
    const paper = document.querySelector('.preview-paper');
    const svg = document.querySelector('#preview-host .document-page')?.shadowRoot?.querySelector('svg');
    const rect = paper.getBoundingClientRect();
    const pageWidthPt = Number((svg?.getAttribute('viewBox') ?? '').trim().split(/\\s+/)[2]);
    const requested = window.__browserDevLastCompile?.previewPage ?? null;
    return {
      clientWidth: body.clientWidth,
      overflowX: body.scrollWidth - body.clientWidth,
      paperWidth: rect.width,
      pageWidthPt,
      requestedWidthPt: requested ? requested.widthPt : null,
      fontPx: pageWidthPt ? (rect.width / pageWidthPt) * 11 : NaN,
    };
  })()`);

/** 源码模式（`Ctrl+E`）与文档模式互切 */
async function toSourceMode() {
  await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
  await sleep(300);
  await settledCompiles();
}
async function toDocumentMode() {
  await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
  await sleep(300);
  await settledCompiles();
}

// `pageFixtures: []`：显式"不用真实夹具" —— 别的套件注册的注入脚本可能还挂在浏览器会话上，
// 空数组会把它盖掉，本套件必须跑在桩的假产物上（否则重排请求不会被桩照做）。
await boot(c, DEV_URL, { pageFixtures: [], settleMs: 600 });
await viewport(1400);

const wide = await measured();
check(
  "文档模式 100%：纸停在自然尺寸（A4 ≈ 757.6px），不铺满整栏",
  Math.abs(wide.paperWidth - 757.6) <= 2 && wide.paperWidth < wide.clientWidth,
  `纸 ${wide.paperWidth.toFixed(1)}px / 栏 ${wide.clientWidth}px`,
);
check(
  "文档模式 100%：预览字号 = 编辑区字号（14px）",
  Math.abs(wide.fontPx - 14) <= 0.1,
  `字号 ${wide.fontPx.toFixed(2)}px`,
);
check("文档模式 100%：没有横向滚动条", wide.overflowX <= 1, `溢出 ${wide.overflowX}px`);

await toSourceMode();
const source = await measured();
check(
  "源码模式：纸铺满预览栏（重排生效）",
  Math.abs(source.paperWidth - source.clientWidth) <= 2,
  `纸 ${source.paperWidth.toFixed(1)}px / 栏 ${source.clientWidth}px`,
);
check(
  "源码模式：预览字号 = 编辑区字号（14px）",
  Math.abs(source.fontPx - 14) <= 0.1,
  `字号 ${source.fontPx.toFixed(2)}px`,
);
check(
  "源码模式：请求页宽 = 栏宽 × 11/14，且产物照做",
  source.requestedWidthPt !== null &&
    Math.abs(source.requestedWidthPt - (source.clientWidth * 11) / 14) <= 1 &&
    Math.abs(source.pageWidthPt - source.requestedWidthPt) <= 1,
  `请求 ${source.requestedWidthPt}pt / 产物 ${source.pageWidthPt}pt`,
);
check("源码模式：没有横向滚动条", source.overflowX <= 1, `溢出 ${source.overflowX}px`);

await toDocumentMode();
await viewport(760);
const narrowWrite = await measured();
check(
  "窄窗口文档模式：纸跟着栏宽缩（重排），字号仍 14px",
  Math.abs(narrowWrite.paperWidth - narrowWrite.clientWidth) <= 2 &&
    Math.abs(narrowWrite.fontPx - 14) <= 0.1,
  `纸 ${narrowWrite.paperWidth.toFixed(1)}px / 栏 ${narrowWrite.clientWidth}px / 字号 ${narrowWrite.fontPx.toFixed(2)}px`,
);
check(
  "窄窗口文档模式：没有横向滚动条",
  narrowWrite.overflowX <= 1,
  `溢出 ${narrowWrite.overflowX}px`,
);

await toSourceMode();
await viewport(560);
const narrowSource = await measured();
check(
  "极窄窗口源码模式：页宽不低于下限、字号仍 14px、不横滚",
  narrowSource.pageWidthPt >= 179.5 &&
    Math.abs(narrowSource.fontPx - 14) <= 0.1 &&
    narrowSource.overflowX <= 1,
  `页宽 ${narrowSource.pageWidthPt}pt / 字号 ${narrowSource.fontPx.toFixed(2)}px / 溢出 ${narrowSource.overflowX}px`,
);

// 注入被文档自己的纸型覆盖：必须退回等比缩放（不横滚、字号不超过编辑区）。
// **不重启页面**：桩是在**每次编译**时读 `reflowfail`，改完查询串触发一次重编译即可。
await c.evaluate(
  "history.replaceState(null, '', location.pathname + '?browserdev=1&reflowfail=1'); true",
);
await toDocumentMode(); // 模式切换 → 栏宽变化 → 重排请求变化 → 重编译
await toSourceMode();
const fallback = await measured();
check(
  "重排被覆盖时退回等比缩放：产物仍是文档自己的纸型、不横滚、字号不超过编辑区",
  Math.abs(fallback.pageWidthPt - 595.28) <= 1 &&
    fallback.fontPx < 14 &&
    fallback.fontPx > 0 &&
    fallback.overflowX <= 1,
  `页宽 ${fallback.pageWidthPt}pt / 字号 ${fallback.fontPx.toFixed(2)}px / 溢出 ${fallback.overflowX}px`,
);

await finish(`预览重排：${state.passed} 项通过`);
