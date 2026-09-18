// 字体设置的纯逻辑：把「设置里选的正文字体（中文）」翻译成传给 Rust 的字体族列表。
// 不碰 Tauri / 组件状态，便于单测（见 font-settings.test.ts）。
//
// 背景（2026-09-14 用 typst 0.15.1 在 Windows / Linux 双侧 CLI 实测）：
// typst 的正文默认字体是 Libertinus Serif（不含汉字），所以**不指定**字体时每个汉字都要走
// typst 的自动回退；而回退打分是「先比衬线标记（Libertinus 的 panose 全 0 → 被判无衬线，
// 于是所有宋体都被扣分）→ 再比家族名谁短」：Windows 落到楷体/隶书，Linux 落到 Noto Sans CJK
// 的日文字形。Rust 侧用 FontConfig 往 Library.styles 注入默认字体族来终结这件事
// （见 typst_world/fonts.rs 的 DEFAULT_FONT_FAMILIES），本模块负责把用户的选择拼成那个列表。

/** 设置里「默认」选项的值：不指定正文字体，交给 Rust 的默认列表 */
export const FONT_CHOICE_DEFAULT = "";

/**
 * 正文字体选择 → 传给 Rust 的 `families`：
 * - 空串（默认）→ `null`：Rust 用它内置的 DEFAULT_FONT_FAMILIES；
 * - 具体族名 X → `[拉丁基准, X, ...其余默认项（去掉 X）]`。
 *
 * 两个刻意的安排：
 * 1. **拉丁基准留在最前**：typst 按列表顺序找"能覆盖该字符"的字体，把 X 放首位会让拉丁文与
 *    数字也变成 X（思源宋体/雅黑都带拉丁字形），与"和原生 typst 观感一致"的目标不符；
 * 2. **其余默认项继续兜底**：打包的思源宋体是子集（4382 码位、CJK 基本区缺 83%），生僻字
 *    得靠 SimSun / 雅黑接住，否则又会掉回楷体。
 */
export function buildFontFamilies(chineseFont: string, defaults: string[]): string[] | null {
  const pick = chineseFont.trim();
  if (!pick) return null;
  const picked = pick.toLowerCase();
  const rest = defaults.filter((f) => f.toLowerCase() !== picked);
  const [latin, ...tail] = rest;
  return latin ? [latin, pick, ...tail] : [pick];
}

/** 字体目录规范化：去首尾空白、去空串、去重（保持顺序） */
export function normalizeFontDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
