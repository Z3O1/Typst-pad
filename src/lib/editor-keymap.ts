// 自定义编辑快捷键绑定：在 basicSetup 默认键位之外补充的编辑器快捷键
import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import {
  indentWithTab,
  deleteLine,
  copyLineDown,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { emptyPairBackspace } from "./auto-pair";

/**
 * 退格时把补出来的空配对整对删掉（`$|$` 与 `$  |  $` 都一次删干净）。
 * 不接管时返回 false，keymap 会继续往下找 basicSetup 的默认退格（不会丢功能）。
 * 删除范围由 emptyPairBackspace 给（**光标两侧各删几个**，行间脚手架是跨在光标两侧的），
 * 只针对配对逻辑补出来的空配对，不会吃掉用户真写进公式的内容。
 */
function deleteEmptyDollarPair(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const span = emptyPairBackspace(view.state.doc.toString(), sel.head);
  if (!span) return false;
  const from = sel.head - span.before;
  const to = sel.head + span.after;
  view.dispatch({ changes: { from, to }, selection: { anchor: from } });
  return true;
}

// CM6 中同一按键的多条绑定按注册顺序执行、先返回 true 者胜出，因此把自定义键位放在
// basicSetup 之后无法覆盖其默认绑定（例如 Mod-d 会被 searchKeymap 的"选中下一处"
// 在空选区时抢先返回 true）。用 Prec.high 提升优先级，保证自定义快捷键先被检查。
export const editorKeymap = Prec.high(
  keymap.of([
    indentWithTab, // Tab 缩进 / Shift+Tab 反缩进
    { key: "Backspace", run: deleteEmptyDollarPair, preventDefault: true }, // 空配对整对删
    { key: "Mod-Shift-d", run: copyLineDown, preventDefault: true }, // 复制当前行到下方（VS Code 语义）
    { key: "Mod-d", run: deleteLine, preventDefault: true }, // 删除当前行（有意覆盖 searchKeymap 的"选中下一处"）
    { key: "Mod-Shift-/", run: toggleBlockComment, preventDefault: true }, // 块注释
    { key: "Mod-/", run: toggleComment, preventDefault: true }, // 行注释（Ctrl+/ 切换）
  ]),
);
