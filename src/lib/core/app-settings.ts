// 应用设置的**纯模型**：「生效的那份」与「设置弹窗里正在编辑的草稿」之间的复制与比对。
//
// 从 `+page.svelte` 抽出来（原来散在 `openSettings` / `saveSettings` 里，混着状态赋值、重编译、
// 状态栏文案）。这里只回答三个问题，都不碰 Svelte / Tauri：
//
// 1. **草稿必须是副本**（`copySettings`）：`fontDirs` 是数组，直接把生效配置交给弹窗的话，
//    在弹窗里加/删目录会立刻改到生效配置 —— 而"点保存才生效"正是这个弹窗的约定。
// 2. **什么算改了字体 / 前缀**（`diffSettings`）：这个判断决定三件事 —— 要不要作废公式缓存
//    （缓存键里没有字体，不作废就会一直拿旧字体渲染）、要不要**保存后立刻重编译**
//    （不然预览停在上一次结果，看起来就是"改了没生效"，用户报过）、以及"设置已保存"要不要让位。
//    目录列表的比对按**归一化后**的结果（trim、去空、去重），否则把同一个目录写成两种拼法也会被
//    当成"改了字体"而白编译一次。
// 3. **保存后状态栏写什么**（`statusAfterSettingsSave`）：编译给出了警告/错误时必须让位 ——
//    那些提示比"设置已保存"要紧（PR 记录里那句"设置已保存"一闪而过就是这个坑）。
import { FONT_CHOICE_DEFAULT, normalizeFontDirs } from "./font-settings";

/** 设置的完整字段集：生效配置与草稿共用同一形状 */
export interface AppSettings {
  prefixEnabled: boolean;
  prefixCode: string;
  chineseFont: string;
  fontDirs: string[];
  restoreSession: boolean;
  autoCheckUpdates: boolean;
}

/** 页面初值（生效配置与草稿都从这里起）：前缀关、字体走默认、恢复会话与自动检查都开 */
export function defaultSettings(): AppSettings {
  return {
    prefixEnabled: false,
    prefixCode: "",
    chineseFont: FONT_CHOICE_DEFAULT,
    fontDirs: [],
    restoreSession: true,
    autoCheckUpdates: true,
  };
}

/** 草稿 = 生效配置的**副本**（`fontDirs` 必须是新数组，见文件头第 1 条） */
export function copySettings(settings: AppSettings): AppSettings {
  return { ...settings, fontDirs: [...settings.fontDirs] };
}

export interface SettingsDiff {
  /** 字体族或字体目录变了 → 要作废公式缓存（缓存键里没有字体） */
  fontsChanged: boolean;
  /** 前缀开关或前缀代码变了 → 重编译（前缀会进编译源） */
  prefixChanged: boolean;
  /** 要把草稿落成生效配置时用的那一份：`fontDirs` 已经归一化 */
  applied: AppSettings;
}

export function diffSettings(current: AppSettings, draft: AppSettings): SettingsDiff {
  const applied = normalizeSettings(draft);
  return {
    fontsChanged:
      applied.chineseFont !== current.chineseFont ||
      applied.fontDirs.join("\n") !== current.fontDirs.join("\n"),
    prefixChanged:
      applied.prefixEnabled !== current.prefixEnabled || applied.prefixCode !== current.prefixCode,
    applied,
  };
}

/** 归一化：字体目录 trim / 去空 / 去重（`normalizeFontDirs`），其余字段原样 */
export function normalizeSettings(settings: AppSettings): AppSettings {
  return { ...settings, fontDirs: normalizeFontDirs(settings.fontDirs) };
}

/** 追加一个字体目录（系统目录选择器选回来的）：归一化顺手去掉重复项 */
export function appendFontDir(dirs: string[], dir: string): string[] {
  return normalizeFontDirs([...dirs, dir]);
}

/** 移除一个字体目录（按原样比较，不做路径规范化 —— 与列表里存的就是同一个字符串） */
export function withoutFontDir(dirs: string[], dir: string): string[] {
  return dirs.filter((d) => d !== dir);
}

/** 保存成功时先写的那句状态栏文案 */
export const SETTINGS_SAVED_STATUS = "设置已保存";

/**
 * 重编译落地后状态栏该保留什么：编译只写了「就绪」（没有更重要的提示）时补「设置已保存」，
 * 否则把警告/编译错误原样留着。
 */
export function statusAfterSettingsSave(compileStatus: string): string {
  return compileStatus === "就绪" ? SETTINGS_SAVED_STATUS : compileStatus;
}
