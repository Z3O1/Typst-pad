// editor-font 单测：装载的容错与"装上了哪几族"。
//
// 真机路径（invoke → ArrayBuffer → FontFace）没法在 jsdom 里跑，所以依赖做成可注入：
// 这里验的是**策略**（逐份独立兜底、装不上不抛、返回真正装上的族名），
// 真字体字节那份由 `scripts/editor-fonts.test.mjs`（静态对齐）与浏览器验收负责。
import { describe, it, expect, vi } from "vitest";
import { EDITOR_FONT_FACES, WRITE_FONT_STACK, installEditorFonts } from "./editor-font";

const bytes = new ArrayBuffer(16);

/** 造一份假依赖：load 按文件名给字节或抛错，makeFace 记录调用 */
function deps(opts: { fail?: string[]; loadFail?: string[] } = {}) {
  const added: { family: string; weight: string }[] = [];
  const made: string[] = [];
  return {
    added,
    made,
    d: {
      load: async (file: string) => {
        if (opts.loadFail?.includes(file)) throw new Error(`取不到 ${file}`);
        return bytes;
      },
      makeFace: (family: string, _b: ArrayBuffer, weight: string) => {
        made.push(`${family}@${weight}`);
        return {
          load: async () => {
            if (opts.fail?.includes(family)) throw new Error(`${family} 载入失败`);
            return undefined;
          },
        };
      },
      fonts: {
        add: (face: unknown) => {
          added.push(face as { family: string; weight: string });
        },
      },
    },
  };
}

describe("installEditorFonts（把打包字体装进 webview）", () => {
  it("三份都装得上 → 注册三面、返回两个族名（Libertinus 有 400/700 两个权重）", async () => {
    const h = deps();
    const families = await installEditorFonts(h.d);
    expect(h.added).toHaveLength(3);
    expect(h.made).toEqual(["Libertinus Serif@400", "Libertinus Serif@700", "Noto Serif CJK SC@400"]);
    expect(families).toEqual(["Libertinus Serif", "Noto Serif CJK SC"]);
  });

  it("某一份取不到 / 载入失败 → 不抛异常，其余照装（最坏只是那一族退回系统字体）", async () => {
    const h = deps({ loadFail: ["LibertinusSerif-Bold.otf"] });
    const families = await installEditorFonts(h.d);
    expect(h.added).toHaveLength(2);
    expect(families).toEqual(["Libertinus Serif", "Noto Serif CJK SC"]);
  });

  it("中文那份失败 → 只报拉丁那一族（调用方不必区分）", async () => {
    const h = deps({ fail: ["Noto Serif CJK SC"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const families = await installEditorFonts(h.d);
    expect(families).toEqual(["Libertinus Serif"]);
    warn.mockRestore();
  });

  it("全都失败 → 返回空数组（调用方什么都不改，字体栈自己退回系统族）", async () => {
    const h = deps({ loadFail: EDITOR_FONT_FACES.map((f) => f.file) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(installEditorFonts(h.d)).resolves.toEqual([]);
    expect(h.added).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("环境里没有 FontFace / document.fonts（jsdom、老引擎）→ 直接返回空数组，不去碰 deps.load", async () => {
    const load = vi.fn(async () => bytes);
    await expect(installEditorFonts({ load, fonts: null })).resolves.toEqual([]);
    await expect(
      installEditorFonts({ load, makeFace: undefined, fonts: { add: () => {} } }),
    ).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("WRITE_FONT_STACK（写作模式的字体栈）", () => {
  it("顺序与 typst 的默认族一致：拉丁 Libertinus 在前、中文思源宋体随后、系统宋体兜底", () => {
    const stack = WRITE_FONT_STACK;
    expect(stack.indexOf("Libertinus Serif")).toBeGreaterThan(-1);
    expect(stack.indexOf("Libertinus Serif")).toBeLessThan(stack.indexOf("Noto Serif CJK SC"));
    expect(stack.indexOf("Noto Serif CJK SC")).toBeLessThan(stack.indexOf("Songti SC"));
    expect(stack.endsWith("serif")).toBe(true);
  });

  it("每个 @font-face 的族名都在栈里出现（否则装上了也用不上）", () => {
    for (const face of EDITOR_FONT_FACES) {
      expect(WRITE_FONT_STACK).toContain(`"${face.family}"`);
    }
  });
});
