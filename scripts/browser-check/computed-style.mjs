// **计算样式守卫**：把"只能靠肉眼/手量才发现"的两类回归变成会红的断言。
//
// 起因（2026-09-19，PR #62 拆 `+page.svelte`）：
//   1. 页面里那条 `* { box-sizing: border-box }` 被 Svelte 编译成**页面自己的作用域类**
//      （`.svelte-<页面hash>`），而 `box-sizing` **不继承** —— 搬进子组件的元素全部静默退回
//      `content-box`。症状：400px 视口下 `.settings-modal` 从 360px 顶满整宽。**五套验收全绿**
//      （只有"显式宽高 + padding/border"的元素会变，靠父容器拉伸的量不出差别）。
//   2. CSS **源序**被合并反了：`.settings-row-font` 与 `.settings-row` 同为单类选择器、靠后者胜，
//      顺序一换，字体行的鼠标指针从 `pointer` 变成 `default`。
// 两者都不是"行为"而是"呈现"，单测与交互断言都看不见，所以单独一套按**计算样式**断言。
//
// 前置与运行：`npm run verify:browser`（或手动起 dev server + CDP 后 `node scripts/browser-check/computed-style.mjs`）。
//
// 无法在此覆盖的两处（诚实记录，别当成"已覆盖"）：`.preview-error` 与 `.error-popover`
// 需要"编译失败"才会出现，而 `?browserdev=1` 的假编译没有开关能造出编译失败
// （`.preview-error` 只在导出 PDF 失败时可达）。它们在 PR #62 里同样受影响，改动这两处时
// 要按 `docs/实现细则/07-测试与审查.md` 的口径手工量。

import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep } from "./harness.mjs";

const { check, state } = createChecker();

/** 窄视口口径与 PR #62 的复核一致（400px 才量得出"顶满整宽"） */
const VIEWPORT = 400;

const c = await connect();
await boot(c, DEV_URL, { settleMs: 400 });
await c.send("Emulation.setDeviceMetricsOverride", {
  width: VIEWPORT,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(400);

/** 打开菜单栏某一项（点菜单标题 → 等下拉出来） */
async function openMenu(prefix) {
  const rect = await c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".menubar .menu-title"))
      .find(e => (e.textContent || "").trim().startsWith(${JSON.stringify(prefix)}));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await c.click(rect.x, rect.y);
}
/** 点下拉里的某一项（按文本包含匹配） */
async function clickMenuItem(text) {
  const rect = await c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
      .find(e => (e.textContent || "").includes(${JSON.stringify(text)}));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await c.click(rect.x, rect.y);
}
/** 量一组元素：boxSizing + 宽度 + 是否横向溢出视口 */
const probe = (selectors) =>
  c.evaluate(`(() => {
    const out = {};
    for (const sel of ${JSON.stringify(selectors)}) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; continue; }
      const r = el.getBoundingClientRect();
      out[sel] = {
        boxSizing: getComputedStyle(el).boxSizing,
        width: +r.width.toFixed(1),
        cursor: getComputedStyle(el).cursor,
        overflowRight: +(r.right - innerWidth).toFixed(1),
        overflowLeft: +r.left.toFixed(1),
      };
    }
    return { viewport: innerWidth, els: out };
  })()`);

console.log(`1) ${VIEWPORT}px 视口：设置弹窗（组件的 * 重置丢了时这里最先顶满整宽）`);
await openMenu("文件");
await c.waitFor(`document.body.innerText.includes("设置")`, { timeout: 5000 });
await clickMenuItem("设置");
await c.waitFor(`!!document.querySelector(".settings-modal")`, { timeout: 5000 });
await sleep(200);

const settings = await probe([
  ".settings-modal",
  ".settings-textarea",
  ".settings-row:not(.settings-row-font)",
  ".settings-row-font",
]);
console.log(`   实测：${JSON.stringify(settings.els)}`);
// 现在组件里各写了一条 `* { box-sizing: border-box }`（见 07 的坑）；退回 content-box 就是它丢了
check(
  ".settings-modal 是 border-box（组件自己的 * 重置还在）",
  settings.els[".settings-modal"]?.boxSizing === "border-box",
);
check(
  `.settings-modal 宽度 ≤ 90vw（border-box 下 90vw=360px；content-box 会加到 410px 顶满视口）`,
  settings.els[".settings-modal"]?.width <= VIEWPORT * 0.9 + 1,
  `实际 ${settings.els[".settings-modal"]?.width}px`,
);
check(
  ".settings-modal 没有横向溢出视口",
  settings.els[".settings-modal"]?.overflowRight <= 0.5 &&
    settings.els[".settings-modal"]?.overflowLeft >= -0.5,
  `left=${settings.els[".settings-modal"]?.overflowLeft} right=+${settings.els[".settings-modal"]?.overflowRight}`,
);
check(
  ".settings-textarea 是 border-box",
  settings.els[".settings-textarea"]?.boxSizing === "border-box",
);

console.log("2) 设置弹窗：CSS 源序（.settings-row-font 必须排在 .settings-row 之前）");
// 两者同为单类选择器、靠后者胜：顺序反了字体行会变成 default（PR #62 踩过）
check(
  "字体行的 cursor 是 pointer（.settings-row 胜出＝源序没被合并反）",
  settings.els[".settings-row-font"]?.cursor === "pointer",
  `实际 ${settings.els[".settings-row-font"]?.cursor}`,
);
check(
  "普通设置行的 cursor 是 pointer",
  settings.els[".settings-row:not(.settings-row-font)"]?.cursor === "pointer",
  `实际 ${settings.els[".settings-row:not(.settings-row-font)"]?.cursor}`,
);
check(
  "设置弹窗内没有元素横向溢出视口",
  await c.evaluate(
    `Array.from(document.querySelectorAll(".settings-modal *")).every((el) => { const r = el.getBoundingClientRect(); return r.right <= innerWidth + 0.5; })`,
  ),
);

await c.key("Escape", { code: "Escape", keyCode: 27 });
await sleep(300);
check("Esc 关掉了设置弹窗", !(await c.evaluate(`!!document.querySelector(".settings-modal")`)));

console.log("3) 关于弹窗（另一条弹窗外壳路径）");
// 量它必须在**宽视口**下：400px 时它被 flex 压到 400，content-box / border-box 都是 400、分辨不出；
// 800px 下 border-box = `max-width: 460px`，content-box = 460 + 24×2 padding + 1×2 border = 510。
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 800,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(300);
await openMenu("帮助");
await c.waitFor(`document.body.innerText.includes("关于")`, { timeout: 5000 });
await clickMenuItem("关于");
await c.waitFor(`!!document.querySelector(".about-modal")`, { timeout: 5000 });
await sleep(200);
const about = await probe([".about-modal", ".modal-close", ".modal-btn"]);
console.log(`   实测：${JSON.stringify(about.els)}`);
check(".about-modal 是 border-box", about.els[".about-modal"]?.boxSizing === "border-box");
check(
  ".about-modal 宽度 ≤ max-width 460px（content-box 会是 510px）且不横向溢出",
  about.els[".about-modal"]?.width <= 461 && about.els[".about-modal"]?.overflowRight <= 0.5,
  `宽度 ${about.els[".about-modal"]?.width}px / 右溢出 +${about.els[".about-modal"]?.overflowRight}`,
);
check(".modal-close 是 border-box", about.els[".modal-close"]?.boxSizing === "border-box");

console.log("4) 没搬进组件的三处必须**保持 content-box**（别把 * 重置塞进全局 modal.css）");
// 这条是反向守卫：`Editor` / `MenuBar` / `ContextMenu` 拆分前就没有这条重置，
// 一旦有人图省事把 `* { box-sizing: border-box }` 提到全局 `modal.css`，它们会被一起改掉
const notReset = await probe([".menubar", ".cm-scroller", ".editor-host"]);
console.log(`   实测：${JSON.stringify(notReset.els)}`);
for (const sel of [".menubar", ".cm-scroller", ".editor-host"]) {
  check(
    `${sel} 仍是 content-box（未被全局重置波及）`,
    notReset.els[sel]?.boxSizing === "content-box",
    `实际 ${notReset.els[sel]?.boxSizing}`,
  );
}

console.log("5) 有 * 重置的其余组件");
const reset = await probe([".statusbar", ".preview-paper", ".preview-pane"]);
console.log(`   实测：${JSON.stringify(reset.els)}`);
for (const sel of [".statusbar", ".preview-paper", ".preview-pane"]) {
  check(
    `${sel} 是 border-box`,
    reset.els[sel]?.boxSizing === "border-box",
    `实际 ${reset.els[sel]?.boxSizing}`,
  );
}

finish(`通过 ${state.passed} 项检查（计算样式守卫）`);
