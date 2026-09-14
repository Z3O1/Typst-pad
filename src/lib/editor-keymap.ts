// 自定义编辑快捷键绑定：在 basicSetup 默认键位之外补充的编辑器快捷键
import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { EditorSelection, Prec } from "@codemirror/state";
import {
  indentWithTab,
  deleteLine,
  copyLineDown,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { emptyPairBackspace } from "./auto-pair";
import { indentForNewLine, isBlankLine } from "./auto-indent";

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

/**
 * 回车换行：新行沿用**上一行的缩进**（用户要求「换行时应该和上一行缩进一样」）。
 *
 * 替代 CM 默认的 `insertNewlineAndIndent`：默认那条的缩进来自语言服务 / 语法树，在 typst
 * 文档里实测**时灵时不灵**（两空格缩进能抄到、四空格抄不到、光标停在行中间时一律丢失），
 * 而用户要的是三种情况同一个结果。判定全在 `auto-indent.ts`（纯函数可单测）。
 *
 * 纯空白行（空行 / 只剩一串缩进）顺手清掉那串残留空白并回到行首 —— 连按回车不该留下
 * 一串"带缩进的空行"（CM 默认行为也是如此，这里保持不变）。
 */
function newlineKeepingIndent(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  view.dispatch(
    state.update(
      state.changeByRange((range) => {
        const line = state.doc.lineAt(range.from);
        const indent = indentForNewLine(line.text, range.from - line.from);
        // 纯空白行：连这行的残留空白一起删掉（多行选区按常规语义只替换选区，不动整行）
        const blank = range.empty && isBlankLine(line.text);
        const from = blank ? line.from : range.from;
        const to = blank ? line.to : range.to;
        const insert = state.lineBreak + indent;
        return {
          changes: { from, to, insert },
          range: EditorSelection.cursor(from + insert.length),
        };
      }),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
  return true;
}

// CM6 中同一按键的多条绑定按注册顺序执行、先返回 true 者胜出，因此把自定义键位放在
// basicSetup 之后无法覆盖其默认绑定（例如 Mod-d 会被 searchKeymap 的"选中下一处"
// 在空选区时抢先返回 true）。用 Prec.high 提升优先级，保证自定义快捷键先被检查。
export const editorKeymap = Prec.high(
  keymap.of([
    indentWithTab, // Tab 缩进 / Shift+Tab 反缩进
    { key: "Enter", run: newlineKeepingIndent, preventDefault: true }, // 新行沿用上一行缩进
    { key: "Shift-Enter", run: newlineKeepingIndent, preventDefault: true }, // 同上（默认键位里两者同义）
    { key: "Backspace", run: deleteEmptyDollarPair, preventDefault: true }, // 空配对整对删
    { key: "Mod-Shift-d", run: copyLineDown, preventDefault: true }, // 复制当前行到下方（VS Code 语义）
    { key: "Mod-d", run: deleteLine, preventDefault: true }, // 删除当前行（有意覆盖 searchKeymap 的"选中下一处"）
    { key: "Mod-Shift-/", run: toggleBlockComment, preventDefault: true }, // 块注释
    { key: "Mod-/", run: toggleComment, preventDefault: true }, // 行注释（Ctrl+/ 切换）
  ]),
);
