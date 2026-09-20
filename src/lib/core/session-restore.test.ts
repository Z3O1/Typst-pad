// 启动恢复计划的单测：五条规则 —— 主题只认合法值、副窗口不恢复内容、空白内容不算上次内容、
// restoreSession 关掉只恢复偏好、标题优先用存档里那份；外加旧存档迁移与脏数据收敛。
import { describe, expect, it } from "vitest";
import { planRestore } from "./session-restore";
import { defaultSettings } from "./app-settings";
import type { PersistedState } from "./persistence";

/** 一份"什么都记过"的完整存档，用例按需覆盖字段 */
const stored = (patch: Partial<PersistedState> = {}): Partial<PersistedState> => ({
  theme: "dark",
  content: "上次写的内容",
  filePath: "/tmp/论文.typ",
  fileTitle: "论文.typ",
  prefixEnabled: true,
  prefixCode: "// 前缀",
  viewMode: "source",
  showPreview: true,
  editorWrap: true,
  dirty: true,
  restoreSession: true,
  autoCheckUpdates: false,
  lastUpdateCheckAt: 1700000000000,
  updateDismissedAt: 1700000001000,
  uiZoom: 1.5,
  chineseFont: "SimSun",
  fontDirs: ["/fonts/a"],
  ...patch,
});

const plan = (patch: Partial<PersistedState> = {}, secondary = false) =>
  planRestore(stored(patch), { isSecondaryWindow: secondary });

describe("planRestore · 偏好", () => {
  it("主题 / 模式 / 预览栏 / 折行 / 缩放 / 时间戳逐字段恢复", () => {
    const p = plan();
    expect(p.theme).toBe("dark");
    expect(p.viewMode).toBe("source");
    expect(p.showPreview).toBe(true);
    expect(p.editorWrap).toBe(true);
    expect(p.uiZoom).toBe(1.5);
    expect(p.lastUpdateCheckAt).toBe(1700000000000);
    expect(p.updateDismissedAt).toBe(1700000001000);
  });

  it("非法主题回落 system（手改过 localStorage 的脏值不许把界面带进不存在的主题）", () => {
    expect(plan({ theme: "neon" as PersistedState["theme"] }).theme).toBe("system");
    expect(plan({ theme: undefined }).theme).toBe("system");
    expect(plan({ theme: null as unknown as "system" }).theme).toBe("system");
    // 三个合法值都要能透传：只测 dark 会因为"夹具恰好是 dark"而看不出白名单少了一项
    expect(plan({ theme: "light" }).theme).toBe("light");
    expect(plan({ theme: "system" }).theme).toBe("system");
    expect(plan({ theme: "dark" }).theme).toBe("dark");
  });

  it("**空存档端到端**：全默认（system / write / 单栏 / 不折行 / 100% / 无时间戳 / 不恢复内容）", () => {
    expect(planRestore({}, { isSecondaryWindow: false })).toEqual({
      theme: "system",
      settings: defaultSettings(),
      viewMode: "write",
      showPreview: false,
      editorWrap: false,
      uiZoom: 1,
      lastUpdateCheckAt: null,
      updateDismissedAt: null,
      content: null,
    });
  });

  it("设置走同一套归一化：目录 trim / 去空 / 去重，字体与前缀原样", () => {
    const p = plan({ fontDirs: [" /fonts/a ", "/fonts/a", "", "/fonts/b"] });
    expect(p.settings).toEqual({
      prefixEnabled: true,
      prefixCode: "// 前缀",
      chineseFont: "SimSun",
      fontDirs: ["/fonts/a", "/fonts/b"],
      restoreSession: true,
      autoCheckUpdates: false,
    });
  });

  it("存档缺字段时取默认值（`defaultSettings()` 那一份）", () => {
    expect(planRestore({}, { isSecondaryWindow: false }).settings).toEqual(defaultSettings());
  });

  it("fontDirs 是新数组：两次调用互不共享、也不与存档共享，且**不就地改**存档", () => {
    const archive: Partial<PersistedState> = { fontDirs: [" /a ", "/a"] };
    const before = structuredClone(archive);
    const first = planRestore(archive, { isSecondaryWindow: false });
    const second = planRestore(archive, { isSecondaryWindow: false });
    expect(first.settings.fontDirs).toEqual(["/a"]); // 归一化过了
    expect(first.settings.fontDirs).not.toBe(second.settings.fontDirs); // 两次调用不共享
    expect(first.settings.fontDirs).not.toBe(archive.fontDirs); // 与存档不共享
    expect(archive).toEqual(before); // 存档没被就地 trim
  });

  it("旧存档迁移：只有 livePreview 时按它推断模式；showPreview 缺失时跟随模式", () => {
    const write = planRestore({ livePreview: true, content: "x" }, { isSecondaryWindow: false });
    expect(write.viewMode).toBe("write");
    expect(write.showPreview).toBe(false); // 写作模式 → 单栏

    const source = planRestore({ livePreview: false, content: "x" }, { isSecondaryWindow: false });
    expect(source.viewMode).toBe("source");
    expect(source.showPreview).toBe(true); // 源码模式 → 双栏对照
  });

  it("**存档里的 showPreview 优先于模式派生**（源码模式关掉预览栏，重启后仍是单栏）", () => {
    expect(plan({ viewMode: "source", showPreview: false }).showPreview).toBe(false);
    expect(plan({ viewMode: "write", showPreview: true }).showPreview).toBe(true);
    // 新存档有 viewMode 但没记 showPreview：跟随模式
    expect(plan({ viewMode: "source", showPreview: undefined }).showPreview).toBe(true);
  });

  it("脏缩放值由 clampZoom 收敛（越界收敛到上下限；非数字 / 缺失回落到 100%）", () => {
    expect(plan({ uiZoom: 99 }).uiZoom).toBe(2.5);
    expect(plan({ uiZoom: 0 }).uiZoom).toBe(0.5); // 收敛到**下界**，不是 100%
    expect(plan({ uiZoom: -3 }).uiZoom).toBe(0.5);
    expect(plan({ uiZoom: Number.NaN }).uiZoom).toBe(1);
    expect(plan({ uiZoom: Number.POSITIVE_INFINITY }).uiZoom).toBe(1);
    expect(plan({ uiZoom: "1.5" as unknown as number }).uiZoom).toBe(1);
    expect(plan({ uiZoom: undefined }).uiZoom).toBe(1);
  });

  it("时间戳只认数字：字符串 / null / 缺失一律 null", () => {
    expect(
      plan({ lastUpdateCheckAt: "1700000000000" as unknown as number }).lastUpdateCheckAt,
    ).toBe(null);
    expect(plan({ lastUpdateCheckAt: null }).lastUpdateCheckAt).toBe(null);
    expect(plan({ updateDismissedAt: "x" as unknown as number }).updateDismissedAt).toBe(null);
    // 缺失 → null；数字（含 0）→ 原样
    const empty = planRestore({}, { isSecondaryWindow: false });
    expect(empty.lastUpdateCheckAt).toBe(null);
    expect(empty.updateDismissedAt).toBe(null);
    expect(plan({ updateDismissedAt: 123 }).updateDismissedAt).toBe(123);
    expect(plan({ lastUpdateCheckAt: 0 }).lastUpdateCheckAt).toBe(0);
  });
});

describe("planRestore · 内容", () => {
  it("正常存档：内容 + 路径 + 标题 + 脏标记一起恢复", () => {
    expect(plan().content).toMatchObject({
      text: "上次写的内容",
      filePath: "/tmp/论文.typ",
      fileTitle: "论文.typ",
      dirty: true,
    });
  });

  it("**副窗口一律不恢复内容**（草稿窗口不该被主窗口的文档顶掉）", () => {
    expect(plan({}, true).content).toBe(null);
  });

  it("`restoreSession` 字段缺失时按默认（开）恢复内容", () => {
    // 存档里根本没这个键（旧版本存档）：`persistence.loadState` 会补 true，这里也要能独立成立
    const p = planRestore({ content: "x", filePath: "/tmp/a.typ" }, { isSecondaryWindow: false });
    expect(p.settings.restoreSession).toBe(true);
    expect(p.content?.text).toBe("x");
    expect(p.content?.dirty).toBe(false);
  });

  it("`restoreSession` 关掉时只恢复偏好，不恢复内容", () => {
    const p = plan({ restoreSession: false });
    expect(p.content).toBe(null);
    expect(p.settings.restoreSession).toBe(false);
    expect(p.theme).toBe("dark"); // 偏好照旧恢复
  });

  it("**空白内容不算上次内容**（只输入过空白字符的存档不恢复）", () => {
    expect(plan({ content: "" }).content).toBe(null);
    expect(plan({ content: "  \n\t " }).content).toBe(null);
    expect(plan({ content: 42 as unknown as string }).content).toBe(null);
    // 不换行空格 / 全角空格：`isBlankDoc`（trim）与旧版 `content.trim() !== ""` 同判
    expect(plan({ content: "\u00a0" }).content).toBe(null);
    expect(plan({ content: "\u3000" }).content).toBe(null);
  });

  it("存档里的标题优先（用户可能在磁盘上改过文件名）；没有标题就从路径取", () => {
    expect(plan({ fileTitle: "旧名字.typ" }).content?.fileTitle).toBe("旧名字.typ");
    expect(plan({ fileTitle: null }).content?.fileTitle).toBe("论文.typ");
  });

  it("未命名文档（存档里没有路径）：路径为 null、标题回落「未命名.typ」", () => {
    expect(plan({ filePath: null, fileTitle: null }).content).toMatchObject({
      text: "上次写的内容",
      filePath: null,
      fileTitle: "未命名.typ",
      dirty: true,
    });
    // 旧版本可能把空串写进 filePath —— 也按"没有路径"处理
    expect(plan({ filePath: "", fileTitle: null }).content?.filePath).toBe(null);
    expect(plan({ filePath: "", fileTitle: null }).content?.fileTitle).toBe("未命名.typ");
    // **没有路径时不认存档里的标题**（空串路径 + 空串标题也不许把窗口标题弄成空白）
    expect(plan({ filePath: null, fileTitle: "旧名字.typ" }).content?.fileTitle).toBe("未命名.typ");
    expect(plan({ filePath: "", fileTitle: "" }).content?.fileTitle).toBe("未命名.typ");
    // 有路径时，空串标题**不是** nullish → 原样保留（与旧版 `?? fileNameOf(filePath)` 同）
    expect(plan({ fileTitle: "" }).content?.fileTitle).toBe("");
  });

  it("脏标记缺失时保守取 false（存过盘又没再改的文档不该带「未保存」圆点）", () => {
    expect(plan({ dirty: undefined }).content?.dirty).toBe(false);
    expect(plan({ dirty: false }).content?.dirty).toBe(false);
  });
});
