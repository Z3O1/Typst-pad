#!/usr/bin/env node
// **一条命令跑完 PKU 真实作业验收**：
//   1) 导出真实夹具（Rust 后端按源文件路径编译四份作业 + 公式产物）
//   2) 跑浏览器逐块几何套件（`writing-pku-docs.mjs`，经 run-all 起 dev server + headless Chromium）
//   3) 打印每份文档的结果与首处失败，便于复查"测到了哪份、错在第几行"
//
//   PKU_ROOT="$HOME/PKU" npm run verify:pku-writing
//
// 这不是新功能，只是把执行报告里那条建议入口固定下来；原文不进仓库，产物在
// `.browser-check/pku-writing/`（已忽略）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

function run(label, cmd, args, extraEnv = {}) {
  console.log(`\n──── ${label} ────`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    stdio: "inherit",
  });
  return res.status ?? 1;
}

const fixturesCode = run("导出真实夹具", "npm", ["run", "fixtures:pku-writing"]);
if (fixturesCode !== 0) {
  console.error("\n✗ 夹具导出失败：不跑几何套件（缺夹具时套件必须失败，不能退回假产物）");
  process.exit(fixturesCode);
}

const suiteCode = run("逐块几何验收", "npm", ["run", "verify:browser"], {
  SKIP_FIXTURES: "1",
  ONLY: "writing-pku-docs.mjs",
});

const summaryPath = join(OUT_DIR, "summary.json");
if (existsSync(summaryPath)) {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  console.log("\n===== PKU 作业逐块验收汇总 =====");
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
  console.log(`\n测量 JSON：${OUT_DIR}/report-doc*.json`);
} else {
  console.error(`\n✗ 没有汇总（套件可能没跑到写报告那一步）：${summaryPath}`);
}

process.exit(suiteCode === 0 ? 0 : suiteCode);
