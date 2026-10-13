// 真实整页产物导出。cargo 失败或零用例均不能写出空夹具。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inspectPageFixtureOutput } from "./page-fixtures-output.mjs";

const command = "cargo";
const args = [
  "test",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "dump_page_fixtures",
  "--",
  "--ignored",
  // 等 libtest 汇总后输出每个测试的 stdout，避免并发进度前缀粘住原生 marker。
  "--show-output",
];
const startedAt = new Date().toISOString();
const evidenceDir = `.browser-check/page-fixtures-exports/${startedAt.replaceAll(":", "-")}-${randomUUID()}`;
mkdirSync(evidenceDir, { recursive: true });
for (const file of ["page-fixtures.mjs", "page-fixtures-output.mjs"]) {
  writeFileSync(`${evidenceDir}/${file}`, readFileSync(new URL(file, import.meta.url)));
}
const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
// 必须先留存原输出和退出状态；即使解析/门禁失败也不能丢掉首轮证据。
writeFileSync(`${evidenceDir}/stdout.log`, result.stdout ?? "");
writeFileSync(`${evidenceDir}/stderr.log`, result.stderr ?? "");
const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const gitDiff = spawnSync("git", ["diff", "HEAD", "--"], { encoding: "utf8" });
writeFileSync(`${evidenceDir}/source.diff`, gitDiff.stdout ?? "");
writeFileSync(
  `${evidenceDir}/command.json`,
  JSON.stringify(
    {
      command,
      args,
      cwd: process.cwd(),
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceHead: gitHead.stdout?.trim(),
      gitHeadStatus: gitHead.status,
      gitDiffStatus: gitDiff.status,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      cargoBuildJobs: process.env.CARGO_BUILD_JOBS ?? null,
      tmpdir: process.env.TMPDIR ?? null,
    },
    null,
    2,
  ),
);
console.log(`原生夹具导出证据：${evidenceDir}`);
const report = inspectPageFixtureOutput(result.stdout ?? "");
writeFileSync(
  `${evidenceDir}/counts.json`,
  JSON.stringify(
    report.groups.map(({ fixtures, ...diagnostics }) => diagnostics),
    null,
    2,
  ),
);
console.log(
  report.groups.map((group) => `${group.marker} ${group.actualCount}/${group.count}`).join("; "),
);
if (result.error || result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  console.error(
    `整页夹具导出失败：status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"}`,
  );
  process.exit(1);
}
if (report.errors.length) {
  console.error(`真实夹具门禁失败（原始输出见 ${evidenceDir}）：\n${report.errors.join("\n")}`);
  process.exit(1);
}
// 所有数量、非空探针和原生诊断门禁通过后才写出这一轮夹具。
for (const group of report.groups) {
  writeFileSync(`.browser-check/${group.file}`, JSON.stringify(group.fixtures));
}
console.log(
  `已导出 ${report.groups.map((group) => `${group.actualCount} 份 ${group.marker}`).join("、")} 真实夹具`,
);
