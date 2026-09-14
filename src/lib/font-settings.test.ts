import { describe, it, expect } from "vitest";
import { FONT_CHOICE_DEFAULT, buildFontFamilies, normalizeFontDirs } from "./font-settings";

const DEFAULTS = [
  "Libertinus Serif",
  "Noto Serif CJK SC",
  "SimSun",
  "Songti SC",
  "Microsoft YaHei",
];

describe("buildFontFamilies 正文字体选择 → 字体族列表", () => {
  it("默认（空串 / 纯空白）→ null：交给 Rust 的内置默认列表", () => {
    expect(buildFontFamilies(FONT_CHOICE_DEFAULT, DEFAULTS)).toBeNull();
    expect(buildFontFamilies("   ", DEFAULTS)).toBeNull();
  });

  it("选了具体字体：拉丁基准仍排第一，选中项排第二", () => {
    expect(buildFontFamilies("SimSun", DEFAULTS)).toEqual([
      "Libertinus Serif",
      "SimSun",
      "Noto Serif CJK SC",
      "Songti SC",
      "Microsoft YaHei",
    ]);
  });

  it("选中项从其余默认项里去掉（不重复出现）", () => {
    const out = buildFontFamilies("Noto Serif CJK SC", DEFAULTS);
    expect(out).not.toBeNull();
    expect(out!.filter((f) => f === "Noto Serif CJK SC")).toHaveLength(1);
    expect(out![0]).toBe("Libertinus Serif");
    expect(out![1]).toBe("Noto Serif CJK SC");
  });

  it("去重不区分大小写", () => {
    const out = buildFontFamilies("simsun", DEFAULTS);
    expect(out!.filter((f) => f.toLowerCase() === "simsun")).toHaveLength(1);
  });

  it("默认列表为空时也给出可用的单元素列表（不返回空数组）", () => {
    expect(buildFontFamilies("SimSun", [])).toEqual(["SimSun"]);
  });
});

describe("normalizeFontDirs 额外字体目录", () => {
  it("去首尾空白、去空串、去重且保持顺序", () => {
    expect(normalizeFontDirs([" /a ", "", "  ", "/b", "/a"])).toEqual(["/a", "/b"]);
  });

  it("空数组原样返回", () => {
    expect(normalizeFontDirs([])).toEqual([]);
  });
});
