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
  it("默认值：前缀关、字体走默认、恢复会话与自动检查都开", () => {
    expect(defaultSettings()).toEqual({
      prefixEnabled: false,
      prefixCode: "",
      chineseFont: "",
      fontDirs: [],
      restoreSession: true,
      autoCheckUpdates: true,
    });
  });

  it("每次返回**新的** fontDirs（页面拿它当初值，别让两处共享同一个数组）", () => {
    expect(defaultSettings().fontDirs).not.toBe(defaultSettings().fontDirs);
  });

  it("字段清单绊线：新增/删除 `AppSettings` 字段时这条会红，提醒回去改页面的 currentSettings / applySettings / 存档恢复 / 持久化快照", () => {
    expect(Object.keys(defaultSettings()).sort()).toEqual([
      "autoCheckUpdates",
      "chineseFont",
      "fontDirs",
      "prefixCode",
      "prefixEnabled",
      "restoreSession",
    ]);
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
  it("什么都没改：两个标记都是 false；草稿里多写的空白不会漏进 applied（会被归一化）", () => {
    const applied = settings({ prefixEnabled: true, prefixCode: "// 前缀", fontDirs: ["/f"] });
    // 草稿故意带上"只有写法不同"的目录：既不算改字体，落回来的也得是归一化那份
    const draft = { ...copySettings(applied), fontDirs: [" /f ", "/f"] };
    const diff = diffSettings(applied, draft);
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

  it("字体与前缀同时改：两个标记一起亮（不会互相掩盖）", () => {
    const base = settings();
    const diff = diffSettings(base, { ...base, chineseFont: "SimSun", prefixEnabled: true });
    expect(diff.fontsChanged).toBe(true);
    expect(diff.prefixChanged).toBe(true);
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

  // 两个 `toBe(false)` 是"守将来"的：这两个开关今天根本不参与 diff 计算，真正要断的是
  // `applied` 把它们透传下去（改了要能生效，只是不必重编译）。
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
  it("normalizeSettings 只动 fontDirs（trim、去空、去重），其余字段原样", () => {
    const draft = settings({
      fontDirs: [" a ", "a", "", "b"],
      prefixEnabled: true,
      prefixCode: "// x",
      chineseFont: "SimSun",
      restoreSession: false,
      autoCheckUpdates: false,
    });
    const normalized = normalizeSettings(draft);
    expect(normalized.fontDirs).toEqual(["a", "b"]);
    expect({ ...normalized, fontDirs: [] }).toEqual({ ...draft, fontDirs: [] });
  });

  it("appendFontDir：追加并归一化；重复目录不会变成两条", () => {
    expect(appendFontDir(["/a"], "/b")).toEqual(["/a", "/b"]);
    expect(appendFontDir(["/a"], " /a ")).toEqual(["/a"]);
  });

  it("withoutFontDir：按**原样**过滤（不 trim、不做路径规范化）", () => {
    expect(withoutFontDir(["/a", "/b"], "/a")).toEqual(["/b"]);
    expect(withoutFontDir(["/a"], "/nope")).toEqual(["/a"]);
    // 带空白的目录不会被"看起来一样"的参数删掉：列表里存的就是它自己那个字符串
    expect(withoutFontDir([" /a "], "/a")).toEqual([" /a "]);
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
