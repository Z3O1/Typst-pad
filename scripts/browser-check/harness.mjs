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
 *
 * **每条断言记耗时**（2026-09-26 提速用）：全量验收里"哪一条在等"以前只能靠猜（一套几百条断言，
 * 只有总时长）。收尾时按耗时倒序打印前 10 条，用来找"确实是空等的固定等待" —— 注意它只是观测，
 * 不改任何断言语义；慢的条目不一定是问题（逐帧采样、真实重编译本来就慢）。
 */
export function createChecker() {
  const state = { passed: 0, failed: 0, timings: [] };
  finishTimings = state.timings;
  function check(name, ok, detail = "") {
    const ms = Date.now() - checkStartedAt;
    // **立刻复位**：下一条的耗时 = 它自己的准备 + 断言，不是"从启动到现在"
    checkStartedAt = Date.now();
    state.timings.push({ name, ms, ok: !!ok });
    if (ok) {
      state.passed++;
      console.log(`  ✓ ${name}${ms >= 400 ? ` [${(ms / 1000).toFixed(1)}s]` : ""}`);
    } else {
      state.failed++;
      console.log(`  ✗ ${name} ${detail}${ms >= 400 ? ` [${(ms / 1000).toFixed(1)}s]` : ""}`);
      process.exitCode = 1;
    }
  }
  return { check, state };
}

/**
 * 上一条断言之后到现在过了多久 —— 由 `check()` 消费。
 *
 * 为什么用模块级的一个时间戳而不是给 `check` 加参数：各套件里有几百处 `check(...)` 调用，
 * 加参数要改几百行、还容易漏；"两次 check 之间的墙钟"正好等于"这一条准备工作 + 断言"的耗时，
 * 够用来定位空等。采样开始前用 `markCheckClock()` 重置（避免把套件启动也算进第一条）。
 */
let checkStartedAt = Date.now();
export function markCheckClock() {
  checkStartedAt = Date.now();
}

/**
 * 统一收尾：打印汇总后**按 `process.exitCode` 退出**（六套语义一致，别再有的 close 有的 exit）。
 * 退出前打印耗时最长的 10 条断言（观测用，见 createChecker 的说明）。
 */
export function finish(message) {
  const slow = [...(finishTimings ?? [])].sort((a, b) => b.ms - a.ms).slice(0, 10);
  if (slow.length > 0) {
    console.log("\n===== 最慢的 10 条断言（观测用） =====");
    for (const t of slow) console.log(`${(t.ms / 1000).toFixed(1).padStart(6)}s  ${t.name}`);
  }
  console.log(`\n${message}`);
  process.exit(process.exitCode ?? 0);
}

/** `finish` 要用的计时表（由 `createChecker` 注册；各套件只调 `finish`） */
let finishTimings = null;

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
 * 上一次 `boot` 注册的注入脚本（`Page.addScriptToEvaluateOnNewDocument` 返回的编号）。
 * **每次 boot 前必须删掉上一次的**：注册是会话级的，不清就会在每次导航时把之前所有夹具
 * 再注入一遍（PKU 套件一次跑 5 个 boot，最后一个页面上要跑 5 份夹具脚本，实测把浏览器拖到
 * `Page.navigate` 30s 不响应）。
 */
let lastInjectedScriptIds = [];

/**
 * 启动到"可以开始断言"的状态，顺序是踩出来的：
 * 1. **一次导航**（2026-09-26 提速）：`localStorage` 用 CDP 的 `Storage.clearDataForOrigin`
 *    从浏览器侧清掉，不再需要"先加载一遍页面才能读 localStorage"。以前 `boot` 是
 *    `goto(url)`（记得它自己还要两跳）→ `localStorage.clear()` → `goto(url)`，一次 boot 四跳；
 *    现在两跳就够（`writing-stability` 有 6 次 boot、`writing-pku-docs` 有 2 次）。
 *    注意**必须在导航之前清**：页面一挂载就会读存档，清晚了这一轮又跑在上一轮的源代码模式上
 *    （`clearDataForOrigin` 是浏览器侧的，不受"当前在 about:blank 上读 localStorage 会抛
 *    SecurityError"这条限制）。
 * 2. 夹具用 `Page.addScriptToEvaluateOnNewDocument` 注入，必须在**导航之前**注册，
 *    桩才拿得到（桩在 `compile_math` / `compile_blocks` / `block_hit_test` 里优先取它）。
 */
export async function boot(
  c,
  url,
  { blockFixtures = null, mathFixtures = null, runtime = false, settleMs = 800 } = {},
) {
  await c.send("Page.enable");
  for (const identifier of lastInjectedScriptIds) {
    try {
      await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    } catch {
      /* 页面已关闭等：忽略 */
    }
  }
  lastInjectedScriptIds = [];
  // 只有要读控制台事件的套件才需要（writing-blocks 查"装饰重建失败 / 插件崩了"）
  if (runtime) await c.send("Runtime.enable");
  /**
   * 清 localStorage。`Storage.clearDataForOrigin` 需要的是**源**（scheme://host:port），
   * 不带路径与查询；取不到源（URL 形状意外）就退回老路：先导航过去再把存档清掉。
   */
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  })();
  if (origin) {
    try {
      await c.send("Storage.clearDataForOrigin", { origin, storageTypes: "local_storage" });
    } catch {
      /* 老浏览器没有这个命令：下面的 goto 之后再清一次兜底 */
    }
  }
  if (blockFixtures) {
    const res = await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__DEV_BLOCK_FIXTURES = ${JSON.stringify(blockFixtures)};`,
    });
    if (res?.identifier) lastInjectedScriptIds.push(res.identifier);
  }
  if (mathFixtures) {
    const res = await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__DEV_MATH_FIXTURES = ${JSON.stringify(mathFixtures)};`,
    });
    if (res?.identifier) lastInjectedScriptIds.push(res.identifier);
  }
  await c.goto(url);
  // 兜底：老后端 / 上面的 clearDataForOrigin 抛了时，趁页面已经在目标源上再清一次
  if (!origin) {
    await c.evaluate(`localStorage.clear()`);
    await c.goto(url);
  }
  // 不再自己 `waitFor(".cm-content")`：`c.goto` 内部已经等到应用挂载出来（见 cdp.mjs）
  markCheckClock(); // 第一条断言的耗时从"启动完成"算起，别把 boot 也算进去
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
 * **让种进 localStorage 的存档真的算最后一份**（2026-09-26）。
 *
 * 应用的存档是 **300ms 防抖**写进 localStorage 的（`+page.svelte` 的 `schedulePersist`），而测试
 * 常常是"改一下界面 → 直接 `setItem` 种一份 → 立刻重载"。应用那次**挂起中的**写盘如果在 `setItem`
 * 之后落地，就会把测试种进去的值原样盖回去 —— 于是读回来还是上一态的主题/开关，测试看起来像
 * "产品没读存档"。
 *
 * 做法：**等过防抖窗口，把要种的那份原样再写一遍**（不是回写"当前值" —— 当前值可能已经被应用
 * 盖过了，回写它等于把应用那份又钉死）。这是让"种存档"这一步确定，不是放宽判据：断言看的仍然是
 * 应用**读到存档之后**的行为。
 *
 * 注意它只解决"写盘竞态"；"应用还没把存档落到页面上就去断言"是另一个竞态，由 `goto` 等
 * `window.__typstPadRestored` 解决（见 cdp.mjs）。
 */
export async function flushStateSeedJson(c, json) {
  await sleep(350);
  await c.evaluate(`localStorage.setItem("typst-pad:state", ${JSON.stringify(json)})`);
}

/** 同上，直接给存档对象 */
export async function flushStateSeed(c, state) {
  await flushStateSeedJson(c, JSON.stringify(state));
}

/**
 * 字节偏移 → UTF-16 位置（`doc` 用 TextEncoder 编成 UTF-8 再截断后解码计长度）。
 * 夹具里的区间是**字节**偏移（Rust 侧），而页面里的位置是 UTF-16 —— 中文/emoji 直接当位置用会整篇错位。
 * 与 `src/lib/core/block-offsets.ts` 同源，但验收脚本跑在 Node 侧、不 import `src/`，所以这里保留一份。
 */
export const byteToPos = (doc, bytes) =>
  new TextDecoder().decode(new TextEncoder().encode(doc).slice(0, bytes)).length;

/**
 * 夹具里的这一块**应当**被直接编辑吗（浏览器验收的期望值）。
 *
 * 与 `src/lib/core/editable-subset.ts` 的决策同口径，但输入只用夹具自带的字段
 * （`kind` / `edit` / `listMarker` / 源码文本）—— 验收脚本跑在 Node 侧、不 import `src/`，
 * 所以这里保留一份**独立**实现；产品口径变了，这里必须一起改（两边不一致时套件会红，
 * 这正是它要抓的"前端与决策漂移"）。
 *
 * 判据：
 *   - 几何：`found && !skipped && heightPt > 0.5`；
 *   - 语法白名单：单源码行的 Paragraph/Heading，或**单源码行、顶格、夹具带 `listMarker`**
 *     的 ListItem/EnumItem；块内不得有白名单之外的 code / raw / 注释；
 *   - 文字对应：`edit.verdict === "verified"` 且 `edit.source` 与当前源码逐字相同
 *     （缺省 = 旧后端 / 桩：按旧口径放行）。
 */
export function editableInFixture(doc, block) {
  if (!block.found || block.skipped || !(block.heightPt > 0.5)) return false;
  const src = doc.slice(byteToPos(doc, block.start), byteToPos(doc, block.end));
  if (src.includes("\n")) return false;
  const textKind = block.kind === "Paragraph" || block.kind === "Heading";
  const listOk =
    (block.kind === "ListItem" || block.kind === "EnumItem") &&
    !!block.listMarker &&
    /^[-+][ \t]+\S/.test(src) &&
    // 含行内公式的列表项不开放（正文列更窄、公式附近分行不可靠，见 core/editable-subset）
    !src.includes("$");
  if (!textKind && !listOk) return false;
  if (hasNonWhitelistedCode(src)) return false;
  if (block.edit && (block.edit.verdict !== "verified" || block.edit.source !== src)) return false;
  return true;
}

/** 源码里有没有"简单函数白名单之外"的代码 / raw / 注释（与 `markup-ranges` 同口径的保守近似） */
function hasNonWhitelistedCode(src) {
  const CALL = /^#(strong|emph)$/;
  const matchBracket = (s, open) => {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      } else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`" || (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*"))) return true;
    if (ch === "#") {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j++;
      const name = src.slice(i, j);
      if (!CALL.test(name) || src[j] !== "[") return true;
      const close = matchBracket(src, j);
      if (close < 0) return true;
      if (/[#`\\<>\n]/.test(src.slice(j + 1, close))) return true;
      i = close + 1;
      continue;
    }
    i++;
  }
  return false;
}
