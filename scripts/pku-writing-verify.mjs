#!/usr/bin/env node
// **一条命令跑完 PKU 真实作业验收**：
//   1) 导出真实夹具（Rust 后端按源文件路径编译四份作业 + 公式产物 + 回放状态）
//   2) 用**真实按键**把编辑回放里"实际会产生的输入结果"抓下来，交给 Rust 编译成逐字夹具
//   3) 跑浏览器逐块几何套件（`writing-pku-docs.mjs`，经 run-all 起 dev server + headless Chromium）
//   4) 打印每份文档的结果与首处失败，便于复查"测到了哪份、错在第几行"
//
//   PKU_ROOT="$HOME/PKU" npm run verify:pku-writing
//
// 这不是新功能，只是把执行报告里那条建议入口固定下来；原文不进仓库，产物在
// `.browser-check/pku-writing/`（已忽略）。
//
// **"本轮真的跑过了"由令牌保证**（2026-09-25 验收教训）：跑之前先删掉上一轮的
// `summary.json` 与逐篇报告，并把 `PKU_RUN_ID` 传给套件；套件把它写进汇总。缺文件、或者
// 令牌对不上，一律按"本轮没有有效结果"处理 —— 绝不再把上一轮的绿汇总打印出来。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT_DIR = join(ROOT, ".browser-check", "pku-writing");
const env = { ...process.env };
if (!env.PKU_ROOT) {
  const guess = join(homedir(), "PKU");
  if (existsSync(guess)) env.PKU_ROOT = guess;
}
/** 本轮令牌：套件把它写进 summary.json，这里核对 */
const RUN_ID = `${Date.now()}-${process.pid}`;

function run(label, cmd, args, extraEnv = {}) {
  console.log(`\n──── ${label} ────`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    stdio: "inherit",
  });
  return res.status ?? 1;
}

// ---------------------------------------------------------------------------
// 0) 清掉上一轮的结论产物：**套件没跑到写报告那一步时，绝不能让旧结论冒充本轮**
// ---------------------------------------------------------------------------
const summaryPath = join(OUT_DIR, "summary.json");
for (const name of [
  "summary.json",
  "report-doc1.json",
  "report-doc2.json",
  "report-doc3.json",
  "report-doc4.json",
]) {
  rmSync(join(OUT_DIR, name), { force: true });
}
console.log(`本轮令牌 PKU_RUN_ID=${RUN_ID}（旧汇总已清除）`);

// ---------------------------------------------------------------------------
// 1) 真实夹具
// ---------------------------------------------------------------------------
const fixturesCode = run("导出真实夹具", "npm", ["run", "fixtures:pku-writing"]);
if (fixturesCode !== 0) {
  console.error("\n✗ 夹具导出失败：不跑几何套件（缺夹具时套件必须失败，不能退回假产物）");
  process.exit(fixturesCode);
}

// ---------------------------------------------------------------------------
// 2) 抓"编辑回放实际会产生的输入结果" → 交给 Rust 编译成逐字夹具
//
// 为什么不能只靠 Rust 推算：Enter / Shift+Enter 的结果里带**编辑器的自动缩进**（实测 P0 的单 LF
// 段落，光标那一行以空格开头，回车后新行也被缩进一个空格），Rust 猜不到编辑器的缩进规则；
// 而桩只在"全文与夹具逐字相同"时才给真实几何，猜错就会静默退回假块、验收变成假绿。
// 所以先跑一遍**抓取**（只做两次按键，不做断言），把结果编译成夹具，再跑验收。
// ---------------------------------------------------------------------------
const captureCode = run("抓取编辑回放的实际结果", "npm", ["run", "verify:browser"], {
  SKIP_FIXTURES: "1",
  ONLY: "writing-pku-capture.mjs",
  PKU_RUN_ID: RUN_ID,
  CDP_TIMEOUT_MS: env.CDP_TIMEOUT_MS ?? "180000",
});
if (captureCode !== 0) {
  console.error("\n✗ 抓取编辑回放结果失败：没有夹具就不跑几何套件（不接受「用假块顶替」）");
  process.exit(captureCode);
}

const extraCode = run("把抓到的结果编译成真实夹具", "npm", ["run", "fixtures:pku-replay"]);
if (extraCode !== 0) {
  console.error("\n✗ 回放夹具编译失败：不跑几何套件");
  process.exit(extraCode);
}

// ---------------------------------------------------------------------------
// 3) 逐块几何验收（必须命中上面那些夹具，未命中直接失败）
// ---------------------------------------------------------------------------
const suiteCode = run("逐块几何验收", "npm", ["run", "verify:browser"], {
  SKIP_FIXTURES: "1",
  ONLY: "writing-pku-docs.mjs",
  PKU_RUN_ID: RUN_ID,
  CDP_TIMEOUT_MS: env.CDP_TIMEOUT_MS ?? "180000",
});

// ---------------------------------------------------------------------------
// 4) 汇总：**只认本轮令牌对得上的那份**
// ---------------------------------------------------------------------------
let summary = null;
if (existsSync(summaryPath)) {
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (e) {
    summary = null;
    console.error(`\n✗ 汇总不是合法 JSON：${summaryPath}（${e.message}）`);
  }
}
if (!summary || summary.runId !== RUN_ID) {
  console.error(
    `\n✗ 本轮没有有效的逐块汇总（${summaryPath}；令牌 ${summary?.runId ?? "（缺）"} ≠ ${RUN_ID}）。\n` +
      `  说明套件没跑到写报告那一步 —— 上面的失败信息才是本轮的结论，${suiteCode === 0 ? "退出码却是 0，属于异常" : "退出码 " + suiteCode}。`,
  );
  process.exit(suiteCode === 0 ? 1 : suiteCode);
}
if (typeof suiteCode !== "number" || suiteCode !== 0) {
  console.error(`\n✗ 逐块几何套件失败（退出码 ${suiteCode}）：本轮汇总不作数，详见上面的失败项。`);
}

console.log("\n===== PKU 作业逐块验收汇总（本轮） =====");
for (const d of summary.docs) {
  const status = d.firstFailure ? "✗" : "✓";
  const geometry = d.comparable ? "" : "（自带 #set page，几何判据跳过）";
  console.log(
    `${status} [${d.priority}] ${d.name} — ${d.pages ?? "?"} 页 ${geometry}` +
      (d.firstFailure
        ? `\n    首处失败：第 ${d.firstFailure.line} 行 ${d.firstFailure.kind} :: ${d.firstFailure.excerpt}`
        : ""),
  );
}
console.log(`\n本轮令牌 ${summary.runId}（生成于 ${summary.generatedAt}）`);
console.log(`测量 JSON：${OUT_DIR}/report-doc*.json`);

process.exit(suiteCode === 0 ? 0 : suiteCode);
