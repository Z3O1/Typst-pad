#!/usr/bin/env node
// **导出 PKU 真实作业的写作模式夹具**（原文不进仓库；产物写进已忽略的 `.browser-check/pku-writing/`）。
//
//   PKU_ROOT="$HOME/PKU" npm run fixtures:pku-writing
//
// 为什么单独一个脚本而不是 package.json 里的一行管道：这一步的失败模式很隐蔽 ——
// `cargo test` 的过滤器命中 0 个用例时**退出码仍是 0**，`2>/dev/null` 又会吞掉编译错误，
// 于是"生成一份空 JSON 然后报绿"。这里把每一步都变成硬判据：
//   * cargo 退出码非 0 → 直接失败（不写任何产物）；
//   * `PKUFIXTURE:` 行数 ≠ 固定样本数（4）→ 失败；
//   * 任一样本 `ok !== true`、块数为 0、没有一块拿到锚点 → 失败；
//   * 源码文件读不到 / 哈希算不出 → 失败。
// 只有全部通过才写 `fixtures.json` 与 `manifest.json`，并打印实际加载的路径与 SHA-256。
//
// 环境变量：
//   PKU_ROOT              作业根目录（默认 `$HOME/PKU`），透传给 Rust 用例
//   PKU_WRITING_COLUMN_PT 版心列宽（pt，默认 371.25 = 495px）；必须与浏览器窗口设置一致
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT_DIR = join(ROOT, ".browser-check", "pku-writing");
const EXPECTED_SAMPLES = 4;

const pkuRoot = process.env.PKU_ROOT ?? join(homedir(), "PKU");
const columnPt = process.env.PKU_WRITING_COLUMN_PT ?? "371.25";

console.log(`PKU 夹具导出：PKU_ROOT=${pkuRoot} 版心=${columnPt}pt`);

const env = {
  ...process.env,
  PKU_ROOT: pkuRoot,
  PKU_WRITING_COLUMN_PT: columnPt,
  PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH}`,
};
const res = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "dump_pku_writing_fixtures",
    "--",
    "--ignored",
    "--nocapture",
  ],
  { cwd: ROOT, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
);
const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
if (res.status !== 0) {
  console.error(`✗ Rust 夹具用例失败（退出码 ${res.status}）——不写出任何产物：`);
  console.error(output.trimEnd().split("\n").slice(-40).join("\n"));
  process.exit(1);
}

const lines = output.split("\n");
const fixtures = [];
for (const line of lines) {
  if (!line.startsWith("PKUFIXTURE:")) continue;
  try {
    fixtures.push(JSON.parse(line.slice("PKUFIXTURE:".length)));
  } catch (e) {
    console.error(`✗ 有一条 PKUFIXTURE 行不是合法 JSON：${e.message}`);
    process.exit(1);
  }
}
const countLine = lines.find((l) => l.startsWith("PKUCOUNT:"));
if (fixtures.length !== EXPECTED_SAMPLES || Number(countLine?.slice("PKUCOUNT:".length)) !== EXPECTED_SAMPLES) {
  console.error(
    `✗ 样本数不对：解析到 ${fixtures.length} 份，Rust 报告 ${countLine ?? "（缺 PKUCOUNT 行）"}，期望 ${EXPECTED_SAMPLES} 份`,
  );
  console.error("  过滤用例名被改 / 用例被 #[cfg] 掉 / cargo 报错被吞 都会长这样，不要用这份产物跑验收。");
  process.exit(1);
}

// ---- 编辑回放夹具（P0：原始 / Enter / 输入 / Backspace）----
const replay = [];
for (const line of lines) {
  if (!line.startsWith("PKUREPLAY:")) continue;
  try {
    replay.push(JSON.parse(line.slice("PKUREPLAY:".length)));
  } catch (e) {
    console.error(`✗ 有一条 PKUREPLAY 行不是合法 JSON：${e.message}`);
    process.exit(1);
  }
}
const replayAnchor = Number(lines.find((l) => l.startsWith("PKUREPLAYANCHOR:"))?.slice("PKUREPLAYANCHOR:".length));
const REPLAY_KEYS = ["A", "B", "C", "D"];
const replayByKey = new Map(replay.map((r) => [r.key, r.fixture]));
if (REPLAY_KEYS.some((k) => !replayByKey.has(k)) || !(replayAnchor > 0)) {
  console.error(
    `✗ 编辑回放夹具不全：拿到 ${[...replayByKey.keys()].join(",") || "（空）"}，锚点 ${replayAnchor}；` +
      `期望 ${REPLAY_KEYS.join(",")} 且锚点 > 0`,
  );
  process.exit(1);
}
for (const [key, fx] of replayByKey) {
  if (fx.ok !== true || !Array.isArray(fx.blocks) || fx.blocks.length === 0) {
    console.error(`✗ 回放状态 ${key}（${fx.name}）没有可用几何`);
    process.exit(1);
  }
}

const manifest = [];
for (const fx of fixtures) {  const problems = [];
  if (fx.ok !== true) problems.push(`ok=${fx.ok}`);
  if (!Array.isArray(fx.blocks) || fx.blocks.length === 0) problems.push("块数为 0");
  const anchored = (fx.blocks ?? []).filter((b) => b.found && typeof b.anchorYpt === "number");
  if (anchored.length === 0) problems.push("没有任何块拿到锚点几何");
  if (!existsSync(fx.absPath)) problems.push(`源码路径不存在：${fx.absPath}`);
  if (problems.length > 0) {
    console.error(`✗ ${fx.name}：${problems.join("、")}`);
    process.exit(1);
  }
  const bytes = readFileSync(fx.absPath);
  fx.sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.push({
    name: fx.name,
    priority: fx.priority,
    relPath: fx.relPath,
    absPath: fx.absPath,
    sha256: fx.sha256,
    ok: fx.ok,
    pages: fx.pages,
    textPt: fx.textPt,
    contentWidthPt: fx.contentWidthPt,
    blockCount: fx.blocks.length,
    anchoredBlocks: anchored.length,
    diagnosticCount: (fx.diagnostics ?? []).length,
  });
}

mkdirSync(OUT_DIR, { recursive: true });
const fixturesPath = join(OUT_DIR, "fixtures.json");
const manifestPath = join(OUT_DIR, "manifest.json");
const replayPath = join(OUT_DIR, "replay.json");
writeFileSync(fixturesPath, JSON.stringify(fixtures));
writeFileSync(replayPath, JSON.stringify({ anchor: replayAnchor, states: REPLAY_KEYS.map((k) => replayByKey.get(k)) }));
writeFileSync(manifestPath, JSON.stringify({ pkuRoot, columnPt: Number(columnPt), samples: manifest }, null, 1));

console.log(`\n✓ 导出 ${fixtures.length} 份真实作业夹具 + ${REPLAY_KEYS.length} 个编辑回放状态（锚点 ${replayAnchor}）`);
for (const m of manifest) {
  console.log(
    `  [${m.priority}] ${m.name}\n      ${m.absPath}\n      sha256=${m.sha256}\n      页数=${m.pages ?? "?"} 块=${m.blockCount}（有锚点 ${m.anchoredBlocks}）诊断=${m.diagnosticCount} 正文字号=${m.textPt}pt`,
  );
}
console.log(`\n夹具：${fixturesPath}\n清单：${manifestPath}`);
