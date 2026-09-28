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
mkdirSync(".browser-check", { recursive: true });
writeFileSync(".browser-check/page-fixtures.json", JSON.stringify(fixtures));
console.log(`已导出 ${fixtures.length} 份真实整页夹具`);
