// scripts/generate-latest-json.mjs 的单元测试（vitest 的 include 里显式放开了 scripts/**/*.test.mjs）。
//
// 为什么值得测：这份清单是**发版链路的产物**——生成错了客户端要么收不到更新、
// 要么拒绝安装（缺签名 / 版本号格式错 / 下载 URL 拼错），而这些东西在 CI 日志里
// 只是一行"成功"，出错往往要到用户点"检查更新"才暴露。
//
// 用 .mjs 而不是 .ts：脚本本身是普通 JS + node 内置模块，仓库没有装 @types/node
// （见 vite.config.js 的 @ts-expect-error），所以它不参与 svelte-check。
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_REPO,
  buildManifest,
  downloadUrl,
  extractChangelogSection,
  isSemver,
  pickUpdaterArtifact,
  updaterTarget,
} from "./generate-latest-json.mjs";

const tempDirs = [];
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "latest-json-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("updaterTarget", () => {
  it("Windows x64 → windows-x86_64（当前 CI 唯一在打的组合）", () => {
    expect(updaterTarget("win32", "x64")).toBe("windows-x86_64");
  });

  it("其余平台按 Tauri 命名规范映射", () => {
    expect(updaterTarget("darwin", "arm64")).toBe("darwin-aarch64");
    expect(updaterTarget("darwin", "x64")).toBe("darwin-x86_64");
    expect(updaterTarget("linux", "x64")).toBe("linux-x86_64");
    expect(updaterTarget("win32", "arm64")).toBe("windows-aarch64");
  });

  it("未知平台/架构直接抛错（不猜一个键写进清单）", () => {
    expect(() => updaterTarget("freebsd", "x64")).toThrow();
    expect(() => updaterTarget("win32", "mips")).toThrow();
  });
});

describe("isSemver", () => {
  it("接受三段式与预发布/构建后缀", () => {
    expect(isSemver("0.8.0")).toBe(true);
    expect(isSemver("1.2.3-beta.1")).toBe(true);
    expect(isSemver("1.2.3+build.7")).toBe(true);
  });

  it("拒绝 v 前缀 / 两段式 / 空值（客户端用 semver 比较，格式错就不更新）", () => {
    expect(isSemver("v0.8.0")).toBe(false);
    expect(isSemver("0.8")).toBe(false);
    expect(isSemver("")).toBe(false);
    expect(isSemver(undefined)).toBe(false);
  });
});

describe("downloadUrl", () => {
  it("指向 GitHub Release 资产，并对文件名做 URL 编码", () => {
    expect(downloadUrl(DEFAULT_REPO, "v0.8.0", "Typst-pad_0.8.0_x64-setup.exe")).toBe(
      "https://github.com/Z3O1/Typst-pad/releases/download/v0.8.0/Typst-pad_0.8.0_x64-setup.exe",
    );
    expect(downloadUrl("a/b", "v1", "含 空格.exe")).toContain("%E5%90%AB%20%E7%A9%BA%E6%A0%BC.exe");
  });
});

describe("pickUpdaterArtifact", () => {
  it("优先 NSIS 的 *-setup.exe（Windows updater 默认走它）", () => {
    expect(
      pickUpdaterArtifact([
        "Typst-pad_0.8.0_x64_en-US.msi",
        "Typst-pad_0.8.0_x64-setup.exe",
        "Typst-pad_0.8.0_x64-setup.exe.sig",
        "Typst-pad_0.8.0_x64_en-US.msi.sig",
      ]),
    ).toBe("Typst-pad_0.8.0_x64-setup.exe");
  });

  it("没有 NSIS 时退回 MSI", () => {
    expect(pickUpdaterArtifact(["a.msi", "a.msi.sig"])).toBe("a.msi");
  });

  it("什么都没有 → null（让调用方报明确的错）", () => {
    expect(pickUpdaterArtifact([])).toBeNull();
    expect(pickUpdaterArtifact(["readme.txt"])).toBeNull();
  });
});

describe("buildManifest", () => {
  const base = {
    version: "0.8.0",
    tag: "v0.8.0",
    assetName: "Typst-pad_0.8.0_x64-setup.exe",
    signature: "dW50cnVzdGVkIGNvbW1lbnQ6...\n",
    notes: "### Added\n- 自动更新",
    target: "windows-x86_64",
    pubDate: "2026-09-14T00:00:00.000Z",
  };

  it("产出静态 JSON 形状：version + notes + pub_date + platforms[target].{signature,url}", () => {
    const m = buildManifest(base);
    expect(m.version).toBe("0.8.0");
    expect(m.notes).toBe("### Added\n- 自动更新");
    expect(m.pub_date).toBe("2026-09-14T00:00:00.000Z");
    expect(Object.keys(m.platforms)).toEqual(["windows-x86_64"]);
    expect(m.platforms["windows-x86_64"].signature).toBe("dW50cnVzdGVkIGNvbW1lbnQ6..."); // 去掉尾换行
    expect(m.platforms["windows-x86_64"].url).toBe(
      "https://github.com/Z3O1/Typst-pad/releases/download/v0.8.0/Typst-pad_0.8.0_x64-setup.exe",
    );
  });

  it("缺签名 → 抛错（没签名的更新包客户端会拒绝安装，必须在发版前就炸）", () => {
    expect(() => buildManifest({ ...base, signature: "   \n" })).toThrow(/签名/);
  });

  it("版本号 / tag / 文件名缺失或非法 → 抛错", () => {
    expect(() => buildManifest({ ...base, version: "v0.8.0" })).toThrow(/semver/);
    expect(() => buildManifest({ ...base, tag: "" })).toThrow(/tag/);
    expect(() => buildManifest({ ...base, assetName: "" })).toThrow(/安装包/);
  });

  it("未传 pubDate 时用当前时间（ISO-8601）", () => {
    const m = buildManifest({ ...base, pubDate: undefined });
    expect(m.pub_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("extractChangelogSection", () => {
  const md = [
    "# 更新日志",
    "",
    "## [Unreleased]",
    "",
    "## [0.8.0] - 2026-09-20",
    "",
    "### Added",
    "",
    "- 自动更新",
    "",
    "## [0.7.2] - 2026-09-14",
    "",
    "### Fixed",
    "",
    "- 旧修复",
  ].join("\n");

  it("取到指定版本的正文，且不含标题行", () => {
    const section = extractChangelogSection(md, "0.8.0");
    expect(section).toContain("### Added");
    expect(section).toContain("- 自动更新");
    expect(section).not.toContain("## [0.8.0]");
    expect(section).not.toContain("旧修复"); // 到下一个 ## 就停
  });

  it("取不到该版本 → 空串（更新说明缺失不能挡住发版）", () => {
    expect(extractChangelogSection(md, "9.9.9")).toBe("");
    expect(extractChangelogSection("", "0.8.0")).toBe("");
  });

  it("不会把 0.7.2 误当成 0.7.20", () => {
    expect(extractChangelogSection("## [0.7.20] - x\n\n- 别的", "0.7.2")).toBe("");
  });
});

describe("CLI（node scripts/generate-latest-json.mjs）", () => {
  const script = "scripts/generate-latest-json.mjs";

  it("从打包目录读安装包与 .sig，写出 latest.json", () => {
    const dir = makeTempDir();
    const nsis = join(dir, "bundle", "nsis");
    mkdirSync(nsis, { recursive: true });
    writeFileSync(join(nsis, "Typst-pad_0.8.0_x64-setup.exe"), "fake installer");
    writeFileSync(join(nsis, "Typst-pad_0.8.0_x64-setup.exe.sig"), "SIG-CONTENT\n");
    const out = join(dir, "latest.json");

    const stdout = execFileSync(
      process.execPath,
      [
        script,
        "--bundle",
        join(dir, "bundle"),
        "--version",
        "0.8.0",
        "--tag",
        "v0.8.0",
        "--target",
        "windows-x86_64",
        "--notes",
        "手写说明",
        "--out",
        out,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(stdout).toContain("Typst-pad_0.8.0_x64-setup.exe");

    const manifest = JSON.parse(readFileSync(out, "utf8"));
    expect(manifest.version).toBe("0.8.0");
    expect(manifest.notes).toBe("手写说明");
    expect(manifest.platforms["windows-x86_64"].signature).toBe("SIG-CONTENT");
    expect(manifest.platforms["windows-x86_64"].url).toContain(
      "/releases/download/v0.8.0/Typst-pad_0.8.0_x64-setup.exe",
    );
  });

  it("没传 --notes 时从 cwd 的 CHANGELOG.md 取该版本正文", () => {
    const dir = makeTempDir();
    const nsis = join(dir, "bundle", "nsis");
    mkdirSync(nsis, { recursive: true });
    writeFileSync(join(nsis, "Typst-pad_0.8.0_x64-setup.exe"), "fake");
    writeFileSync(join(nsis, "Typst-pad_0.8.0_x64-setup.exe.sig"), "SIG");
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "# 更新日志\n\n## [0.8.0] - 2026-09-20\n\n### Added\n\n- 自动更新\n",
    );
    const out = join(dir, "latest.json");

    execFileSync(
      process.execPath,
      [join(process.cwd(), script), "--bundle", join(dir, "bundle"), "--version", "0.8.0", "--out", out],
      { cwd: dir, encoding: "utf8" },
    );
    expect(JSON.parse(readFileSync(out, "utf8")).notes).toContain("- 自动更新");
  });

  it("打包目录里没有安装包 → 非零退出并给出明确原因", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "bundle"), { recursive: true });
    let stderr = "";
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [script, "--bundle", join(dir, "bundle"), "--out", join(dir, "o.json")],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      );
    } catch (e) {
      failed = true;
      stderr = String(e.stderr ?? "");
    }
    expect(failed).toBe(true);
    expect(stderr).toContain("没找到安装包");
  });
});
