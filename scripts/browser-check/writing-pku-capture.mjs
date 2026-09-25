// **编辑回放"实际输入结果"的抓取**（`verify:pku-writing` 的第 2 步）。
//
// 为什么单独一步：Enter / Shift+Enter 的结果里带**编辑器的自动缩进**，Rust 侧推算不出来 ——
// 实测 P0 的单 LF 段落，光标那一行以空格开头，回车后新行也被缩进一个空格，于是 Rust 备的
// "复用换行 / 插两个换行"两种变体**一种都对不上**，桩就静默退回假块（`__browserDevBlocksMatched
// = false`），而旧断言只看"文本变长了 + 重新编译过"就报绿。这里把**实际产生的文本**抓下来，
// 交给 Rust 编译成逐字夹具（`fixtures:pku-replay`），主套件再按"必须命中"来验收。
//
// 本脚本**不做几何断言**，只保证"抓到的状态是确定的、且与原文不同"（抓不到就非零退出）。
//
//   CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-pku-capture.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "./cdp.mjs";
import { BLOCKS_URL as URL_BLOCKS, boot, byteToPos, sleep } from "./harness.mjs";

const OUT_DIR = new URL("../../.browser-check/pku-writing/", import.meta.url).pathname;
const fixtures = JSON.parse(readFileSync(`${OUT_DIR}fixtures.json`, "utf8"));
const replay = JSON.parse(readFileSync(`${OUT_DIR}replay.json`, "utf8"));
const p0 = fixtures.find((f) => f.priority === "P0") ?? fixtures[0];
const states = replay.states;

if (!(replay.anchor2 > 0)) {
  console.error("✗ replay.json 里没有单 LF 段落锚点（anchor2）：夹具不完整");
  process.exit(1);
}

const c = await connect();
await boot(c, URL_BLOCKS, {
  blockFixtures: [p0, ...states],
  mathFixtures: p0.math ?? [],
  settleMs: 800,
});

const setDoc = (doc) =>
  c.evaluate(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(doc)} } });
    return true;
  })()`);
const setCursor = (pos) =>
  c.evaluate(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    view.dispatch({ selection: { anchor: ${pos} } });
    view.focus();
    return view.state.selection.main.head;
  })()`);
const docText = () =>
  c.evaluate(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`);

const base = states[0].doc;
const mlPos = byteToPos(base, replay.anchor2);
const usedFixtures = states.map((s) => s.name);

await setDoc(base);
await c.waitFor(`window.__browserDevBlocksMatched === true`, { timeout: 30000 });
const caret = await setCursor(mlPos);
if (caret !== mlPos) {
  console.error(`✗ 光标没落在锚点上：${caret} ≠ ${mlPos}`);
  process.exit(1);
}

/** 按一次键 → 抓文本 → 撤销回原文 */
async function capture(label, keyOpts) {
  await c.key(keyOpts.key, keyOpts);
  await sleep(500);
  const doc = await docText();
  if (doc === base) {
    console.error(`✗ ${label} 之后文本没变（按键没生效？）`);
    process.exit(1);
  }
  // 撤销回原文（多次 Ctrl+Z 直到回到 base，最多 5 次）
  for (let i = 0; i < 5 && (await docText()) !== base; i++) {
    await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
    await sleep(250);
  }
  if ((await docText()) !== base) {
    console.error(`✗ ${label} 之后撤不回原文`);
    process.exit(1);
  }
  await setDoc(base);
  await c.waitFor(`window.__browserDevBlocksMatched === true`, { timeout: 30000 });
  await setCursor(mlPos);
  const delta = doc.length - base.length;
  let i = 0;
  while (i < Math.min(doc.length, base.length) && doc[i] === base[i]) i++;
  console.log(
    `  · ${label}：长度 ${base.length} → ${doc.length}（Δ${delta}），首个不同 @${i}：` +
      JSON.stringify(doc.slice(i, i + 20)),
  );
  return doc;
}

console.log(
  `抓取编辑回放的实际结果（P0=${p0.name}，锚点 ${mlPos}，已有夹具 ${usedFixtures.join("/")}）`,
);
const enter = await capture("Enter（段末）", { key: "Enter", code: "Enter", keyCode: 13 });
const soft = await capture("Shift+Enter（显式换行）", {
  key: "Enter",
  code: "Enter",
  keyCode: 13,
  modifiers: 8,
});

const out = {
  generatedAt: new Date().toISOString(),
  anchor2: replay.anchor2,
  baseSha256Hint: base.length,
  enter: { name: "单LF段落 Enter（实际含缩进）", doc: enter },
  soft: { name: "单LF段落 Shift+Enter（实际含缩进）", doc: soft },
};
writeFileSync(`${OUT_DIR}capture.json`, JSON.stringify(out, null, 1));
console.log(`✓ 抓到两种输入结果 → ${OUT_DIR}capture.json（下一步 fixtures:pku-replay 会编译它们）`);
if (existsSync(`${OUT_DIR}capture.json`)) await c.close();
