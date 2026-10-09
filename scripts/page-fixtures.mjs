// 真实整页产物导出。cargo 失败或零用例均不能写出空夹具。
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const result = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "dump_page_fixtures",
    "--",
    "--ignored",
    "--nocapture",
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "整页夹具导出失败\n");
  process.exit(1);
}
const fixtures = result.stdout
  .split("\n")
  .filter((line) => line.startsWith("PAGEFIXTURE:"))
  .map((line) => JSON.parse(line.slice("PAGEFIXTURE:".length)));
if (!fixtures.length || fixtures.some((fixture) => !fixture.pages.length || !fixture.carets.length))
  throw new Error("整页夹具或命中探针为空");
if (
  fixtures.some(
    (fixture) =>
      (fixture.brokenDoc != null && !fixture.diagnostics?.length) ||
      (fixture.brokenPreviewDoc != null && !fixture.previewDiagnostics?.length),
  )
)
  throw new Error("错误回退夹具缺少原生诊断，不能使用空错误验收");
mkdirSync(".browser-check", { recursive: true });
writeFileSync(".browser-check/page-fixtures.json", JSON.stringify(fixtures));
const cursorFixtures = result.stdout
  .split("\n")
  .filter((line) => line.startsWith("CURSORFIXTURE:"))
  .map((line) => JSON.parse(line.slice("CURSORFIXTURE:".length)));
if (
  cursorFixtures.length !== 9 ||
  cursorFixtures.some((fixture) => !fixture.pages.length || !fixture.cursorQueries.length)
)
  throw new Error("光标渲染夹具缺失，不能使用空探针验收");
writeFileSync(".browser-check/cursor-fixtures.json", JSON.stringify(cursorFixtures));
const expansionFixtures = result.stdout
  .split("\n")
  .filter((line) => line.startsWith("EXPANSIONFIXTURE:"))
  .map((line) => JSON.parse(line.slice("EXPANSIONFIXTURE:".length)));
if (
  expansionFixtures.length !== 24 ||
  expansionFixtures.some((fixture) => !fixture.pages.length || !fixture.cursorQueries.length)
)
  throw new Error("光标展开夹具缺失，不能跳过真实重排验证");
writeFileSync(".browser-check/expansion-fixtures.json", JSON.stringify(expansionFixtures));
console.log(
  `已导出 ${fixtures.length} 份真实整页夹具、${cursorFixtures.length} 份光标渲染夹具、${expansionFixtures.length} 份展开夹具`,
);
