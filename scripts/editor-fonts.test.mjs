// 「写作模式装上打包字体」这条链路的静态体检（vitest，纯读文件，普通 JS）。
//
// **为什么要有这一条**：那几份字体要跨四层才对得上 ——
//   ① `src-tauri/src/typst_world/fonts.rs` 的 `EDITOR_FONT_FILES` 白名单（Rust 只肯读这几个文件名）
//   ② `src/lib/editor-font.ts` 的 `EDITOR_FONT_FACES`（前端要哪几份、注册成哪个族名）
//   ③ `WRITE_FONT_STACK`（写作模式的字体栈 —— 族名写错就等于"装上了也用不上"）
//   ④ `src-tauri/fonts/` 里真有这些文件、真的随 `bundle.resources` 分发
//
// 任何一层对不上，**代码都能跑、页面都不报错**，只是悄悄退回系统字体 —— 正是这个仓库最怕的
// "看着能用、其实没生效"（见 CLAUDE.md 里 0.7.10 的主题）。所以这里静态钉住。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RUST_WORLD = "src-tauri/src/typst_world/fonts.rs";
const TS_FONTS = "src/lib/editor-font.ts";
const TAURI_CONF = "src-tauri/tauri.conf.json";

/** 递归收集 `src-tauri/src` 下的所有 .rs：命令的**定义**可能被拆进任意子模块 */
function rustSources(dir = "src-tauri/src") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return rustSources(p);
    return e.name.endsWith(".rs") ? [p] : [];
  });
}

const rust = readFileSync(RUST_WORLD, "utf8");
const ts = readFileSync(TS_FONTS, "utf8");

/** 抠出 Rust 的 `pub const EDITOR_FONT_FILES: &[&str] = &[ "a", "b" ];` 里的字符串列表 */
function rustList(name) {
  const start = rust.indexOf(`pub const ${name}`);
  expect(start, `${RUST_WORLD} 里找不到 ${name}`).toBeGreaterThan(-1);
  const open = rust.indexOf("[", rust.indexOf("=", start));
  const close = rust.indexOf("]", open);
  return [...rust.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 抠出 TS 里 `export const EDITOR_FONT_FACES ... = [ {...} ];` 的 file 字段 */
function tsFaceFiles() {
  const start = ts.indexOf("export const EDITOR_FONT_FACES");
  expect(start, `${TS_FONTS} 里找不到 EDITOR_FONT_FACES`).toBeGreaterThan(-1);
  const open = ts.indexOf("[", start);
  const close = ts.indexOf("];", open);
  return [...ts.slice(open, close).matchAll(/file:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("写作模式的打包字体（Rust 白名单 ↔ 前端 @font-face ↔ 仓库文件）", () => {
  const rustFiles = rustList("EDITOR_FONT_FILES");
  const tsFiles = tsFaceFiles();

  it("Rust 白名单与前端名单**完全一致**（顺序也一致，改一边就得改另一边）", () => {
    expect(rustFiles.length).toBeGreaterThan(0);
    expect(tsFiles).toEqual(rustFiles);
  });

  it("每份字体都在 src-tauri/fonts 里，且体积像一份真字体", () => {
    for (const file of rustFiles) {
      const path = `src-tauri/fonts/${file}`;
      expect(existsSync(path), `缺字体文件：${path}`).toBe(true);
      expect(statSync(path).size, `${file} 太小`).toBeGreaterThan(100_000);
    }
  });

  it("打包字体真的会随应用分发（tauri.conf.json 的 bundle.resources 里有 fonts）", () => {
    const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
    const resources = conf.bundle?.resources ?? {};
    expect(JSON.stringify(resources)).toContain("fonts");
  });

  it("字体栈里的族名顺序与 typst 默认族一致（拉丁 Libertinus 在中文之前）", () => {
    const defaults = rustList("DEFAULT_FONT_FAMILIES");
    const stack = ts.slice(
      ts.indexOf("export const WRITE_FONT_STACK"),
      ts.indexOf(";", ts.indexOf("export const WRITE_FONT_STACK")),
    );
    const positions = defaults
      .filter((family) => stack.includes(`"${family}"`))
      .map((family) => [family, stack.indexOf(`"${family}"`)]);
    expect(positions.length, "字体栈里至少要命中 typst 默认族里的两个").toBeGreaterThanOrEqual(2);
    const sorted = [...positions].sort((a, b) => a[1] - b[1]).map(([f]) => f);
    expect(sorted).toEqual(positions.map(([f]) => f));
    expect(positions[0][0]).toBe("Libertinus Serif");
    expect(positions[1][0]).toBe("Noto Serif CJK SC");
  });

  it("Rust 侧的命令注册在 invoke_handler 里（漏注册 = 前端拿到 unknown command）", () => {
    // 定义在哪个文件里不关这条测试的事 —— lib.rs 按关注点拆过（2026-09-20），
    // `bundled_font` 现在住 `font_commands.rs`。写死路径会让"搬家"平白弄红一条守卫。
    // 用 `pub fn` 而不是 `fn`：真命令是 `pub fn`，而 `block_geometry/tests.rs` / `typst_world/tests.rs`
    // 里的同名 helper 不是 —— 否则"真命令删了、测试文件里补一个同名 helper"也能骗过这条。
    const defines = rustSources().some((f) =>
      /pub\s+(?:async\s+)?fn bundled_font\s*\(/.test(readFileSync(f, "utf8")),
    );
    expect(defines, "src-tauri/src 下没有任何文件定义 bundled_font").toBe(true);
    // 真正要钉的是**注册表**：`generate_handler!` 就是 IPC 契约，漏一条只在真机上暴露
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    const handler = lib.slice(lib.indexOf("generate_handler!"));
    expect(handler.slice(0, handler.indexOf("]"))).toContain("bundled_font");
  });

  it("前端只用 invoke 拿字节，且失败时不影响编辑区（不让异常冒出去）", () => {
    expect(ts).toContain('invoke<ArrayBuffer | number[] | Uint8Array>("bundled_font"');
    expect(ts).toMatch(/catch \(e\) \{\s*console\.warn\(/);
  });
});
