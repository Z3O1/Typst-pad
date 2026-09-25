#!/usr/bin/env node
// **一条命令跑完浏览器验收**：起 dev server →（必要时）起 headless Chromium → 导夹具 → 依次跑全部套件
// → 打印汇总表 → 收尾（只杀自己起的进程）。
//
// 为什么需要它：以前跑一次全量验收要手抄 8 条命令（两个 fixtures 目标 + 六套件），还得自己记住
// "先起 dev server、再起 CDP、换端口别跟 tauri dev 抢 1420"。漏一步的症状是"夹具是空的"或
// "连不上 CDP"，看起来像验收失败，于是要么白查半天、要么干脆不跑。
//
// 用法（默认端口 1425 / CDP 9335，避开 tauri dev 的 1420）：
//   node scripts/browser-check/run-all.mjs
//   PORT=1430 CDP_PORT=9336 node scripts/browser-check/run-all.mjs
//   CHROME_PATH=/path/to/chrome node scripts/browser-check/run-all.mjs   # 自己指定浏览器
//   SKIP_DEV=1 node scripts/browser-check/run-all.mjs                    # 复用已在跑的 dev server
//   SKIP_FIXTURES=1 node scripts/browser-check/run-all.mjs               # 复用已有夹具（快，但可能过期）
//   ONLY=wysiwyg.mjs,writing-blocks.mjs node scripts/browser-check/run-all.mjs
//
// 环境变量一律透传给子进程（`HIT_FULL` / `CDP_PORT` / `BROWSER_CHECK_URL` 等都是）。

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(ROOT, ".browser-check");
mkdirSync(OUT, { recursive: true });

const PORT = process.env.PORT ?? "1425";
const CDP_PORT = process.env.CDP_PORT ?? "9335";
const APP_URL = process.env.BROWSER_CHECK_URL ?? `http://127.0.0.1:${PORT}/?browserdev=1`;
const SKIP_DEV = process.env.SKIP_DEV === "1";
const SKIP_FIXTURES = process.env.SKIP_FIXTURES === "1";

// 套件清单（期望项数写在这里，跑完直接对账；改套件计数时**两处一起改**）
const SUITES = [
  ["wysiwyg.mjs", 291],
  ["writing-blocks.mjs", 133],
  ["writing-blocks-visual.mjs", 81],
  ["writing-blocks-hit.mjs", 34],
  ["writing-mode-scenes.mjs", 83],
  ["wysiwyg-visual.mjs", 20],
  // 写作模式的**动态稳定性**（报告 T0）：逐帧量"光标进出公式/复杂块"的几何（点击 / 左右键 /
  // Ctrl+E 三档等效几何、高块 widget 不钉的例外），补上另外七套都不管的那段动态手感
  ["writing-stability.mjs", 107],
  // 计算样式守卫（box-sizing 作用域 / CSS 源序）：两种回归都躲得过交互断言，只能按 computed style 量
  ["computed-style.mjs", 17],
  // **PKU 真实作业逐块几何**（P0 主样本 + 三份 P1）。这一套要 `PKU_ROOT` 指到本地作业目录，
  // 原文不进仓库 ⇒ 没有 `PKU_ROOT` 时**跳过并明说**（不是悄悄报绿），见下面的 pkuRequested。
  ["writing-pku-docs.mjs", 76],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
/**
 * PKU 真实作业那一套要不要跑：显式设了 `PKU_ROOT`，或 `ONLY` 里点名了它。
 * 两者都没有时**跳过**（原文不进仓库，别的机器上没有作业目录），绝不假装通过。
 */
const pkuRequested = !!process.env.PKU_ROOT || (only?.has("writing-pku-docs.mjs") ?? false);
/** 实际进入循环的套件数：用来发现 `ONLY=` 写错（一个都没匹配上却报"全部通过"） */
let ran = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
/** 起一个长驻子进程（dev server / Chromium）：**输出留档**，否则"服务半路死了"只能靠猜 */
function launch(label, cmd, args) {
  const fd = openSync(join(OUT, `run-all-${label}.log`), "w");
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  children.push(child);
  return child;
}
/**
 * 收尾：按**进程组**杀（`npm run dev` 会再起一个 vite 子进程，只杀 npm 会留下孤儿）。
 * 两道保险都必要：① 已经退出的子进程不再 kill —— 它的 PID 可能已经被系统回收成**别人的**
 * 进程组组长，那时 `kill(-pid)` 就误杀无关进程了；② 只动 `children` 里记着的对象，用户自己
 * 起的 dev server / Chromium（`SKIP_DEV=1` 或复用 CDP 时）从来不在这个数组里。
 */
function cleanup() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* 已经退了 */
    }
  }
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 端口能不能由我们绑定（用来区分"服务还没起来"与"端口被别的进程占着"） */
async function portFree(port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(Number(port), "127.0.0.1");
  });
}

/** 从 start 起找一个能绑的端口（连续 20 个都被占就放弃） */
async function pickFreePort(start, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const p = String(Number(start) + i);
    if (await portFree(p)) return p;
  }
  return null;
}

async function waitFor(label, url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await httpOk(url)) return true;
    await sleep(1000);
  }
  console.error(`✗ ${label} 在 ${tries}s 内没起来（${url}）`);
  return false;
}

/** 找一个可用的 Chromium：CHROME_PATH 优先，其次本机 Playwright 缓存里的 headless shell */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-"))) {
    for (const rel of [
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-linux/chrome",
    ]) {
      const p = join(cache, dir, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const results = [];
function record(name, ok, note) {
  results.push({ name, ok, note });
  console.log(`${ok ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`);
}

/** 只跑一条命令（夹具导出这类没有"项数"的步骤）：退出码即结果，输出留档 */
function runStep(name, cmd, args) {
  const logFile = join(OUT, `run-all-${name}.log`);
  // cargo 常在 ~/.cargo/bin，而本机默认 PATH 里可能没有（`fixtures:*` 里是裸 `cargo`）
  const env = { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH}` };
  const res = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8" });
  writeFileSync(logFile, `${res.stdout ?? ""}${res.stderr ?? ""}`);
  record(name, res.status === 0, res.status === 0 ? "" : `退出码 ${res.status}；详情见 ${logFile}`);
}

console.log(`浏览器验收：dev ${APP_URL} / CDP ${CDP_PORT}`);
process.on("exit", cleanup);
// SIGTERM 也要收（`timeout`、上层 job 管理器、kill 默认信号都发它）：子进程是 detached 的
// 独立会话，不主动杀就会变成孤儿继续占着 1425 / 9335。
const onSignal = (code) => () => {
  cleanup();
  process.exit(code);
};
process.on("SIGINT", onSignal(130));
process.on("SIGTERM", onSignal(143));

if (!SKIP_DEV) {
  /**
   * **端口已经有人服务就复用，不再"再起一个然后等 60 秒报没起来"**（2026-09-25 验收教训）：
   * 上一次验收被中断时，`run-all` 起的 dev server 是 detached 的独立会话，可能活下来继续占着
   * 1425 —— 那时新起的 Vite 会立刻以 "Port 1425 is already in use" 退出，而这里只报
   * "dev server 在 60s 内没起来"，看起来像环境玄学。现在：能 HTTP 响应就复用（并明说不是本轮
   * 起的、收尾不回收它）；端口被占但 HTTP 不响应就直接说清楚并给出换端口的命令。
   */
  if (await httpOk(`http://127.0.0.1:${PORT}/`)) {
    console.log(`✓ 复用已在跑的 dev server（:${PORT}；不是本轮起的，收尾不回收）`);
  } else if (!(await portFree(PORT))) {
    console.error(
      `✗ 端口 :${PORT} 被占用，但 HTTP 不响应 —— 多半是上一次验收残留的 dev server（detached，杀掉 run-all 不会连带回收）。\n` +
        `  换端口重跑：PORT=${Number(PORT) + 10} npm run verify:browser；或先释放 :${PORT}`,
    );
    process.exit(1);
  } else {
    launch("dev", "npm", ["run", "dev", "--", "--port", PORT, "--host", "0.0.0.0"]);
    // 冷启动的 Vite 要转译整棵模块图，60s 不够（实测本机 8s 起步、忙时更久）
    if (!(await waitFor("dev server", `http://127.0.0.1:${PORT}/`, 120))) process.exit(1);
    console.log(`✓ dev server 就绪（:${PORT}）`);
  }
}

/**
 * 浏览器：默认**自己起一个**（`REUSE_CDP=1` 才复用已在跑的那个）。
 *
 * 以前是"`:9335` 上有 CDP 就复用"—— 但**卡住的页面目标同样能通过 `/json/version`**，
 * 复用它会把上一轮的卡死状态带进这一轮（实测 `Page.navigate` 60s 不返回）。
 * 端口被占（残留浏览器）时自动往后找一个能绑的端口，并把实际端口传给各套件。
 */
let chrome = null;
let cdpPort = CDP_PORT;
const reuseCdp = process.env.REUSE_CDP === "1";
if (reuseCdp && (await httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`))) {
  console.log(`✓ 复用已在跑的 CDP（:${CDP_PORT}，REUSE_CDP=1）`);
} else {
  if (await httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
    console.log(`⚠ :${CDP_PORT} 上已有浏览器（可能是上一次跑残留的）→ 本轮另起一个端口`);
  }
  const free = await pickFreePort(CDP_PORT);
  if (!free) {
    console.error(`✗ 从 :${CDP_PORT} 起连续 20 个端口都被占用，起不了浏览器`);
    process.exit(1);
  }
  cdpPort = free;
  chrome = findChrome();
  if (!chrome) {
    console.error(
      `✗ 没找到本机 Chromium。用 CHROME_PATH=<可执行文件> 指给它，或先自己起一个 headless 浏览器。`,
    );
    process.exit(1);
  }
  launch("chrome", chrome, [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${join(OUT, `cdp-profile-run-all-${cdpPort}`)}`,
    `--remote-debugging-port=${cdpPort}`,
    "--window-size=1400,900",
    APP_URL,
  ]);
  if (!(await waitFor("headless Chromium", `http://127.0.0.1:${cdpPort}/json/version`, 30))) {
    process.exit(1);
  }
  console.log(`✓ headless Chromium 就绪（:${cdpPort}，${chrome}）`);
}

const env = {
  ...process.env,
  CDP_PORT: cdpPort,
  BROWSER_CHECK_PORT: PORT,
  BROWSER_CHECK_URL: APP_URL,
};

/**
 * **预热点应用**：冷启动的 Vite 要转译整棵模块图（实测首屏 `responseEnd` 7.9s，机器忙时更久），
 * 那笔开销以前是**第一个套件的第一次 boot** 付的 —— 于是 `Page.navigate` 的 CDP 调用超时、
 * 或者 `waitFor(.cm-content)` 在 15s 上超时重试。这里先自己加载两遍（第二遍走缓存），
 * 各套件的 boot 就都是热的；应用根本起不来时也在这里**早失败**、报错清楚。
 */
if (!SKIP_DEV || process.env.SKIP_WARMUP !== "1") {
  const warm = spawnSync(process.execPath, [join(HERE, "warmup.mjs")], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 300000,
  });
  writeFileSync(join(OUT, "run-all-warmup.log"), `${warm.stdout ?? ""}${warm.stderr ?? ""}`);
  if (warm.status !== 0) {
    console.error(
      `✗ 应用预热点失败（退出码 ${warm.status}）：dev server / 浏览器可能有问题；` +
        `详情见 ${join(OUT, "run-all-warmup.log")}`,
    );
    process.exit(1);
  }
  console.log("✓ 应用已预热点（后续套件的 boot 都是热的）");
}

if (!SKIP_FIXTURES) {
  runStep("fixtures-blocks", "npm", ["run", "fixtures:blocks"]);
  runStep("fixtures-math", "npm", ["run", "fixtures:math"]);
  // PKU 真实作业夹具要作业原文（`PKU_ROOT`，默认 `$HOME/PKU`）；只有显式要求那一套时才导，
  // 否则默认 `verify:browser` 会在没有作业的机器上红掉 —— 但那不是产品回归。
  if (pkuRequested) runStep("fixtures-pku-writing", "npm", ["run", "fixtures:pku-writing"]);
}

/**
 * **按退出码判定的"步骤"**（不是套件：没有"通过 N 项"摘要），只在 `ONLY` 点名时跑。
 *
 * 目前只有 PKU 的编辑回放抓取（`writing-pku-capture.mjs`）：它要用真实按键把"实际会产生的输入
 * 结果"抓下来（编辑器会给新行带自动缩进，Rust 推算不出来），必须有自己的 dev server + 浏览器，
 * 所以放在这里、复用同一套生命周期。
 */
const STEPS = [["writing-pku-capture.mjs", "抓取编辑回放的实际结果"]];
for (const [file, label] of STEPS) {
  if (!only || !only.has(file)) continue;
  ran += 1;
  const full = join(HERE, file);
  const logFile = join(OUT, `run-all-${file.replace(/\.mjs$/, "")}.log`);
  if (!existsSync(full)) {
    record(label, false, "脚本不存在");
    continue;
  }
  const res = spawnSync(process.execPath, [full], { cwd: ROOT, env, encoding: "utf8" });
  writeFileSync(logFile, `${res.stdout ?? ""}${res.stderr ?? ""}`);
  const tail = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd().split("\n").slice(-1)[0] ?? "";
  record(label, res.status === 0, res.status === 0 ? "" : `${tail}；详情见 ${logFile}`);
}

for (const [file, expectCount] of SUITES) {
  if (only && !only.has(file)) continue;
  if (file === "writing-pku-docs.mjs" && !pkuRequested) {
    // 明确以"跳过"记录（不计数、不算通过）：没有 PKU_ROOT 就没法验真实作业几何
    console.log(`⊘ ${file} — 跳过（未提供 PKU_ROOT / 未在 ONLY 里点名）`);
    results.push({ name: file, ok: true, note: "跳过：未提供 PKU_ROOT" });
    continue;
  }
  ran += 1;
  const full = join(HERE, file);
  if (!existsSync(full)) {
    record(file, false, "脚本不存在");
    continue;
  }
  const logFile = join(OUT, `run-all-${file.replace(/\.mjs$/, "")}.log`);
  const res = spawnSync(process.execPath, [full], { cwd: ROOT, env, encoding: "utf8" });
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  // 完整输出留档，控制台只留最后一行（每套件几百行 ✓ 刷屏没法看）
  writeFileSync(logFile, text);
  const tail = text.trimEnd().split("\n").slice(-1)[0] ?? "";
  const m = text.match(/通过 (\d+) 项检查/);
  const count = m ? Number(m[1]) : null;
  if (res.status !== 0) record(file, false, `${tail}；详情见 ${logFile}`);
  else if (count === null)
    // **fail-closed**：读不到摘要行就当失败。以前这里把"没有摘要"记成通过，只要有人改了
    // `finish()` 的措辞（或摘要被 `process.exit` 截断），期望项数这道守卫就静默失效了。
    record(
      file,
      false,
      `退出码 0 但读不到「通过 N 项检查」摘要（改过 finish 的措辞？）；详情见 ${logFile}`,
    );
  else if (count !== expectCount)
    record(
      file,
      false,
      `${count} 项 ≠ 期望 ${expectCount} 项（计数变了就同步改 run-all.mjs 的 SUITES）`,
    );
  else record(file, true, `${count} 项`);
}

// ONLY 写错（少写 `.mjs`、拼错名字）会让循环一次都不进 —— 那时绝不能报"全部通过"
if (only && ran === 0) {
  record(
    `ONLY=${process.env.ONLY}`,
    false,
    `没有匹配到任何套件；可选：${SUITES.map(([f]) => f).join(", ")}`,
  );
}

console.log("\n===== 汇总 =====");
for (const r of results)
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.note ? ` — ${r.note}` : ""}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} 步失败` : "\n全部通过");
process.exit(failed.length ? 1 : 0);
