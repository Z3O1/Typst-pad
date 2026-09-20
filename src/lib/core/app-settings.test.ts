// 应用设置纯模型的单测：草稿必须是副本、字体/前缀的"改了没改"判定（含目录归一化）、
// 保存后状态栏文案（编译警告/错误要让位）。
import { describe, expect, it } from "vitest";
import {
  appendFontDir,
  copySettings,
  defaultSettings,
  diffSettings,
  normalizeSettings,
  SETTINGS_SAVED_STATUS,
  statusAfterSettingsSave,
  withoutFontDir,
} from "./app-settings";
import type { AppSettings } from "./app-settings";

const settings = (patch: Partial<AppSettings> = {}): AppSettings => ({
  ...defaultSettings(),
  ...patch,
});

describe("defaultSettings", () => {
  it("页面初值：前缀关、字体走默认、恢复会话与自动检查都开", () => {
    expect(defaultSettings()).toEqual({
      prefixEnabled: false,
      prefixCode: "",
      chineseFont: "",
      fontDirs: [],
      restoreSession: true,
      autoCheckUpdates: true,
    });
  });
});

describe("copySettings", () => {
  it("fontDirs 是**新数组**：在草稿里增删目录不会碰到生效配置", () => {
    const applied = settings({ fontDirs: ["/fonts/a"] });
    const draft = copySettings(applied);
    expect(draft).toEqual(applied);
    expect(draft.fontDirs).not.toBe(applied.fontDirs);
    draft.fontDirs.push("/fonts/b");
    expect(applied.fontDirs).toEqual(["/fonts/a"]);
  });
});

describe("diffSettings", () => {
  it("什么都没改：两个标记都是 false，applied 等于原配置", () => {
    const applied = settings({ prefixEnabled: true, prefixCode: "// 前缀", fontDirs: ["/f"] });
    const diff = diffSettings(applied, copySettings(applied));
    expect(diff.fontsChanged).toBe(false);
    expect(diff.prefixChanged).toBe(false);
    expect(diff.applied).toEqual(applied);
  });

  it("改了正文字体 / 前缀开关 / 前缀文本 → 各自点亮对应标记（互不误报）", () => {
    const base = settings({ prefixCode: "// a" });
    const fontOnly = diffSettings(base, { ...base, chineseFont: "SimSun" });
    expect(fontOnly.fontsChanged).toBe(true);
    expect(fontOnly.prefixChanged).toBe(false);

    const textOnly = diffSettings(base, { ...base, prefixCode: "// b" });
    expect(textOnly.prefixChanged).toBe(true);
    expect(textOnly.fontsChanged).toBe(false);

    const toggleOnly = diffSettings(base, { ...base, prefixEnabled: true });
    expect(toggleOnly.prefixChanged).toBe(true);
    expect(toggleOnly.fontsChanged).toBe(false);
  });

  it("目录列表按**归一化后**比对：只差空白/重复/空项不算改字体（否则白编译一次）", () => {
    const applied = settings({ fontDirs: ["/fonts/a", "/fonts/b"] });
    const draft = settings({ fontDirs: [" /fonts/a ", "/fonts/b", "", "/fonts/a"] });
    expect(diffSettings(applied, draft).fontsChanged).toBe(false);
  });

  it("真的加/删目录 → 算改了字体，且 applied 里的目录已归一化", () => {
    const applied = settings({ fontDirs: ["/fonts/a"] });
    const added = diffSettings(applied, settings({ fontDirs: [" /fonts/a ", "/fonts/new"] }));
    expect(added.fontsChanged).toBe(true);
    expect(added.applied.fontDirs).toEqual(["/fonts/a", "/fonts/new"]);
    expect(diffSettings(applied, { ...applied, fontDirs: [] }).fontsChanged).toBe(true);
  });

  it("目录顺序也参与比对（顺序会影响引擎的查找优先级）", () => {
    const applied = settings({ fontDirs: ["/a", "/b"] });
    expect(diffSettings(applied, { ...applied, fontDirs: ["/b", "/a"] }).fontsChanged).toBe(true);
  });

  it("会话恢复 / 自动检查这两个开关**不算**字体或前缀改动（不触发重编译）", () => {
    const base = settings();
    const diff = diffSettings(base, settings({ restoreSession: false, autoCheckUpdates: false }));
    expect(diff.fontsChanged).toBe(false);
    expect(diff.prefixChanged).toBe(false);
    expect(diff.applied.restoreSession).toBe(false);
    expect(diff.applied.autoCheckUpdates).toBe(false);
  });
});

describe("normalizeSettings / 目录增删", () => {
  it("normalizeSettings 只动 fontDirs（trim、去空、去重）", () => {
    expect(normalizeSettings(settings({ fontDirs: [" a ", "a", "", "b"] })).fontDirs).toEqual([
      "a",
      "b",
    ]);
  });

  it("appendFontDir：追加并归一化；重复目录不会变成两条", () => {
    expect(appendFontDir(["/a"], "/b")).toEqual(["/a", "/b"]);
    expect(appendFontDir(["/a"], " /a ")).toEqual(["/a"]);
  });

  it("withoutFontDir：按原样过滤（列表里存的就是同一个字符串）", () => {
    expect(withoutFontDir(["/a", "/b"], "/a")).toEqual(["/b"]);
    expect(withoutFontDir(["/a"], "/nope")).toEqual(["/a"]);
  });
});

describe("statusAfterSettingsSave", () => {
  it("编译只写了「就绪」→ 补「设置已保存」", () => {
    expect(statusAfterSettingsSave("就绪")).toBe(SETTINGS_SAVED_STATUS);
    expect(SETTINGS_SAVED_STATUS).toBe("设置已保存");
  });

  it("编译给出了警告/错误 → 原样留着（那些提示比「设置已保存」要紧）", () => {
    expect(statusAfterSettingsSave("编译错误：2 处")).toBe("编译错误：2 处");
    expect(statusAfterSettingsSave("3 处警告")).toBe("3 处警告");
  });
});
