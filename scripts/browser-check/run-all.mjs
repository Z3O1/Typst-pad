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
  ["writing-blocks-visual.mjs", 74],
  ["writing-blocks-hit.mjs", 31],
  ["writing-mode-scenes.mjs", 70],
  ["wysiwyg-visual.mjs", 20],
  // 写作模式的**动态稳定性**（报告 T0）：逐帧量"光标进出公式/复杂块"的几何（点击 / 左右键 /
  // Ctrl+E 三档等效几何、高块 widget 不钉的例外），补上另外七套都不管的那段动态手感
  ["writing-stability.mjs", 107],
  // 计算样式守卫（box-sizing 作用域 / CSS 源序）：两种回归都躲得过交互断言，只能按 computed style 量
  ["computed-style.mjs", 17],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((s) => s.trim())) : null;
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
  launch("dev", "npm", ["run", "dev", "--", "--port", PORT, "--host", "0.0.0.0"]);
  if (!(await waitFor("dev server", `http://127.0.0.1:${PORT}/`))) process.exit(1);
  console.log(`✓ dev server 就绪（:${PORT}）`);
}

let chrome = null;
if (await httpOk(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
  console.log(`✓ 复用已在跑的 CDP（:${CDP_PORT}）`);
} else {
  chrome = findChrome();
  if (!chrome) {
    console.error(
      `✗ CDP :${CDP_PORT} 上没有浏览器，也没找到本机 Chromium。\n` +
        `  要么先起一个（headless + --remote-debugging-port=${CDP_PORT}），要么用 CHROME_PATH=<可执行文件> 指给它。`,
    );
    process.exit(1);
  }
  launch("chrome", chrome, [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${join(OUT, `cdp-profile-run-all-${CDP_PORT}`)}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--window-size=1400,900",
    APP_URL,
  ]);
  if (!(await waitFor("headless Chromium", `http://127.0.0.1:${CDP_PORT}/json/version`, 30))) {
    process.exit(1);
  }
  console.log(`✓ headless Chromium 就绪（:${CDP_PORT}，${chrome}）`);
}

const env = { ...process.env, CDP_PORT, BROWSER_CHECK_PORT: PORT, BROWSER_CHECK_URL: APP_URL };

if (!SKIP_FIXTURES) {
  runStep("fixtures-blocks", "npm", ["run", "fixtures:blocks"]);
  runStep("fixtures-math", "npm", ["run", "fixtures:math"]);
}

for (const [file, expectCount] of SUITES) {
  if (only && !only.has(file)) continue;
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
