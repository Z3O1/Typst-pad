// 浏览器验收（`scripts/browser-check/` 下的六套件）的公共骨架。
//
// 为什么存在：6 个套件曾把同一份 `check()` / `SHOT` / 启动序列 / 夹具守卫 / 收尾各抄一遍，
// 而且抄出了分叉 —— 四套用 `process.exit(process.exitCode ?? 0)` 收尾、两套只 `c.close()`
// 靠隐式退出；两套在**导航之前**就 `localStorage.clear()`（冷启动时页面还停在 `about:blank`，
// 那里读 localStorage 会抛 SecurityError），另两套先 `goto` 再清、顺序反而是对的。
// 现在只留这一份：改一处，六套一起变。
//
// 各套件只保留自己的用例：
//   import { BLOCKS_URL, boot, createChecker, finish, loadFixtures, replaceDocument, shotPath, sleep } from "./harness.mjs";
//   const { check, state } = createChecker();
//   const fixtures = loadFixtures("block-fixtures.json", { hint: "先跑 npm run fixtures:blocks" });
//   const c = await connect();
//   await boot(c, BLOCKS_URL, { blockFixtures: fixtures });
//   …用例…
//   await c.close();
//   finish(`通过 ${state.passed} 项检查；截图：.browser-check/xxx-*.png`);

import { readFileSync } from "node:fs";
import { DEV_URL } from "./cdp.mjs";

/** 写作模式（带 `&blocks=1`）的页面地址：桩只在带这个参数时给块切片（见 browser-dev-stub） */
export const BLOCKS_URL = `${DEV_URL}&blocks=1`;

/** 固定延时。真正该等"条件成立"的地方请用 `c.waitFor`（它是有 deadline 的轮询） */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 截图路径：写到仓库内（`.browser-check/`，见 `.gitignore`）。
 * 沙箱只允许写工作区，而 Chrome 需要 Windows 路径 —— 故用 CDP 取 base64 后由 Node 落盘。
 */
export const shotPath = (name) =>
  new URL(`../../.browser-check/${name}.png`, import.meta.url).pathname;

/**
 * 断言 + 计数。失败只置 `process.exitCode = 1`（不立刻抛），这样一次运行能看完所有失败项。
 * `state.passed` / `state.failed` 也交出来，供收尾与"手工对账"的套件（writing-blocks 的输入组）用。
 */
export function createChecker() {
  const state = { passed: 0, failed: 0 };
  function check(name, ok, detail = "") {
    if (ok) {
      state.passed++;
      console.log(`  ✓ ${name}`);
    } else {
      state.failed++;
      console.log(`  ✗ ${name} ${detail}`);
      process.exitCode = 1;
    }
  }
  return { check, state };
}

/** 统一收尾：打印汇总后**按 `process.exitCode` 退出**（六套语义一致，别再有的 close 有的 exit） */
export function finish(message) {
  console.log(`\n${message}`);
  process.exit(process.exitCode ?? 0);
}

/**
 * 读夹具，并在"夹具为空 / 没有可用用例"时**硬失败**。
 *
 * `fixtures:*` 用 `2>/dev/null` 吞掉 cargo 的错误，而 **cargo test 过滤器命中 0 个用例时退出码
 * 仍是 0** ⇒ 会写出一份空 json；消费者若只 `for (const fx of fixtures)`，就会跑 0 项断言、
 * 退出码 0（看着全绿）。`predicate` 用来表达"有夹具但没用例"的变体（点击那套要的是带探针的夹具）。
 */
export function loadFixtures(
  fileName,
  { predicate = (f) => f.length > 0, what = "夹具", hint = "" } = {},
) {
  const path = new URL(`../../.browser-check/${fileName}`, import.meta.url).pathname;
  const fixtures = JSON.parse(readFileSync(path, "utf8"));
  if (!predicate(fixtures)) {
    console.error(
      `${what}是空的或没有可用用例：${path}${hint ? `；${hint}` : ""}（别拿空夹具跑验收）`,
    );
    process.exit(1);
  }
  return fixtures;
}

/**
 * 启动到"可以开始断言"的状态，顺序是踩出来的：
 * 1. 先 `goto(url)` **再**清 localStorage —— 冷启动时页面停在 `about:blank`，
 *    在那里读 localStorage 会抛 SecurityError（两套件踩过）；
 * 2. 夹具用 `Page.addScriptToEvaluateOnNewDocument` 注入，必须在**最后一次导航之前**注册，
 *    桩才拿得到（桩在 `compile_math` / `compile_blocks` / `block_hit_test` 里优先取它）；
 * 3. 清完存档**再导航一次**，否则上一轮遗留的"源代码模式"会让页面根本不渲染公式，
 *    第一条断言莫名超时（实测踩过）。
 */
export async function boot(
  c,
  url,
  { blockFixtures = null, mathFixtures = null, runtime = false, settleMs = 800 } = {},
) {
  await c.send("Page.enable");
  // 只有要读控制台事件的套件才需要（writing-blocks 查"装饰重建失败 / 插件崩了"）
  if (runtime) await c.send("Runtime.enable");
  await c.goto(url);
  if (blockFixtures) {
    await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__DEV_BLOCK_FIXTURES = ${JSON.stringify(blockFixtures)};`,
    });
  }
  if (mathFixtures) {
    await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__DEV_MATH_FIXTURES = ${JSON.stringify(mathFixtures)};`,
    });
  }
  await c.evaluate(`localStorage.clear()`);
  await c.goto(url);
  // 不再自己 `waitFor(".cm-content")`：`c.goto` 内部已经等到应用挂载出来（见 cdp.mjs）
  if (settleMs) await sleep(settleMs);
}

/** 用输入替换整篇文档（三套件各抄了一遍：点进编辑区 → 全选 → 输入 → 等编译沉降） */
export async function replaceDocument(c, doc, settleMs = 700) {
  await c.click(400, 300);
  await c.selectAll();
  await c.type(doc);
  if (settleMs) await sleep(settleMs);
}

/**
 * 字节偏移 → UTF-16 位置（`doc` 用 TextEncoder 编成 UTF-8 再截断后解码计长度）。
 * 夹具里的区间是**字节**偏移（Rust 侧），而页面里的位置是 UTF-16 —— 中文/emoji 直接当位置用会整篇错位。
 * 与 `src/lib/core/block-offsets.ts` 同源，但验收脚本跑在 Node 侧、不 import `src/`，所以这里保留一份。
 */
export const byteToPos = (doc, bytes) =>
  new TextDecoder().decode(new TextEncoder().encode(doc).slice(0, bytes)).length;
