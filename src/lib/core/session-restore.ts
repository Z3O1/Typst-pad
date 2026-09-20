// 启动恢复：把 localStorage 里的存档（`PersistedState`）**翻译成一套要落的状态**。
//
// 从 `+page.svelte` 的 `onMount` 开头搬出来（原来 ~45 行内联赋值，混着主题校验、旧存档迁移、
// 内容恢复条件）。这里只算"该恢复成什么"，不碰 Svelte、不碰 DOM —— 页面拿到计划后一次性赋值。
//
// **与 `document-session.ts` 的分工**：那边管"**当前这次**会话的文件生命周期"（打开/保存/新建），
// 这里管"**上次**会话在启动时恢复成什么"。都叫 session，一个向前、一个向后。
//
// 为什么值得单测（这几条都是"内容丢了"或"启动形态不对"级别的规则，而浏览器验收只覆盖了
// "恢复内容 / 关掉开关不恢复"两条）：
// 1. **主题只认三个合法值**：存档里的脏值（手改过 localStorage / 旧版本字段）不许把界面带成
//    一个不存在的主题，非法值直接回落 `system`。
// 2. **副窗口（Ctrl+Shift+N）一律不恢复内容**：它是空白草稿窗口，恢复出主窗口的文档会让人以为
//    "新窗口把我正在写的文章带过来了"，而那个窗口的改动又不会记进存档。
// 3. **空白内容不算"上次内容"**：只输入过空白字符的存档不恢复（与"有未保存修改"的判据同一套
//    —— `isBlankDoc`），否则用户会看到一个"空但很脏"的文档，关窗时还要被追问一次。
// 4. **`restoreSession` 关掉时只恢复偏好**（主题/前缀/模式/字体/缩放），不恢复内容。
// 5. 标题恢复：**有路径时**优先用存档里的 `fileTitle`（可能与磁盘上文件的当前名字不一致——用户
//    改过文件名），没有就从路径取；**没有路径**（含空串）时回落「未命名.typ」——与搬出来之前
//    的行为一致（当时整段只在 `saved.filePath` 为真时才执行）。
import { defaultSettings, normalizeSettings } from "./app-settings";
import type { AppSettings } from "./app-settings";
import { fileNameOf, isBlankDoc, UNTITLED_TITLE } from "./doc-utils";
import type { PersistedState, ThemePreference } from "./persistence";
import { clampZoom } from "./zoom";

const THEMES: readonly ThemePreference[] = ["system", "dark", "light"];

export interface RestoredContent {
  text: string;
  /** 存档里没有路径时是 `null`（页面按"未命名文档"处理） */
  filePath: string | null;
  /** 存档里有标题就用它（用户可能在磁盘上改过文件名）；没有路径时是「未命名.typ」 */
  fileTitle: string;
  /** 上次会话结束时是否还有未保存修改（存档缺这个字段时保守取 false） */
  dirty: boolean;
}

export interface RestorePlan {
  theme: ThemePreference;
  /** 与设置弹窗同一形状：页面用 `applySettings(plan.settings)` 一次落下去 */
  settings: AppSettings;
  viewMode: "write" | "source";
  showPreview: boolean;
  editorWrap: boolean;
  /** 已收敛到档位（`clampZoom`）：脏数据/缺失都回落到 100% */
  uiZoom: number;
  lastUpdateCheckAt: number | null;
  updateDismissedAt: number | null;
  /** 要恢复的内容；`null` = 这次不恢复内容（页面就不许动 doc / editorDoc / filePath / dirty） */
  content: RestoredContent | null;
}

/**
 * 算出这次启动要恢复成什么。
 *
 * `saved` 直接来自 `loadState()`（它已经把缺失字段补成默认值，但**不校验值本身**，所以这里
 * 仍然要对主题、时间戳这类字段做一次"只认合法形态"的把关）。
 */
export function planRestore(
  saved: Partial<PersistedState>,
  opts: { isSecondaryWindow: boolean },
): RestorePlan {
  const defaults = defaultSettings();
  // 与设置弹窗保存时同一套归一化（目录 trim / 去空 / 去重）：存档里可能留着旧写法
  const settings: AppSettings = normalizeSettings({
    prefixEnabled: saved.prefixEnabled ?? defaults.prefixEnabled,
    prefixCode: saved.prefixCode ?? defaults.prefixCode,
    chineseFont: saved.chineseFont ?? defaults.chineseFont,
    fontDirs: [...(saved.fontDirs ?? defaults.fontDirs)],
    restoreSession: saved.restoreSession ?? defaults.restoreSession,
    autoCheckUpdates: saved.autoCheckUpdates ?? defaults.autoCheckUpdates,
  });

  // 旧的 livePreview 布尔 → 模式（0.6.0 前的存档；`loadState` 也会补，这里是兜底）
  const viewMode: "write" | "source" =
    saved.viewMode ?? (saved.livePreview === false ? "source" : "write");

  return {
    // 非法主题回落 system（别把界面带进一个不存在的主题）。搬出来之前是"非法就**保持当前值**"，
    // 而页面 `theme` 的初值恒为 `"system"`、恢复是它第一次被写，所以两者等价；将来若初值变了
    // （或恢复之前有人改过 theme），这里得收一个 `currentTheme` 参数才不会悄悄改语义。
    theme: THEMES.includes(saved.theme as ThemePreference)
      ? (saved.theme as ThemePreference)
      : "system",
    settings,
    viewMode,
    // 存档没记过预览栏开关时跟随模式：写作模式 → 单栏
    showPreview: saved.showPreview ?? viewMode === "source",
    editorWrap: saved.editorWrap ?? false,
    uiZoom: clampZoom(saved.uiZoom),
    lastUpdateCheckAt: typeof saved.lastUpdateCheckAt === "number" ? saved.lastUpdateCheckAt : null,
    updateDismissedAt: typeof saved.updateDismissedAt === "number" ? saved.updateDismissedAt : null,
    content: planContent(saved, settings.restoreSession, opts.isSecondaryWindow),
  };
}

/** 内容恢复的三道闸门（见文件头第 2~4 条）：副窗口 / 开关关掉 / 内容是空白 —— 任一命中就不恢复 */
function planContent(
  saved: Partial<PersistedState>,
  restoreSession: boolean,
  isSecondaryWindow: boolean,
): RestoredContent | null {
  if (isSecondaryWindow) return null;
  if (!restoreSession) return null;
  if (typeof saved.content !== "string" || isBlankDoc(saved.content)) return null;
  // 存档里的路径可能是空串（旧版本写过）——空串按"没有路径"处理（页面初值就是未命名文档）
  const filePath = saved.filePath ? saved.filePath : null;
  return {
    text: saved.content,
    filePath,
    // 没有路径时**不认**存档里的标题（旧版此时整段跳过、标题保持「未命名.typ」）
    fileTitle: filePath === null ? UNTITLED_TITLE : (saved.fileTitle ?? fileNameOf(filePath)),
    dirty: saved.dirty ?? false,
  };
}
