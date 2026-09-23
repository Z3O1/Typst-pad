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
import type { Command } from "@codemirror/view";
import { insertNewTypstListItem, insertTypstListContinuation } from "codemirror-lang-typst/lezer";
import { emptyPairBackspace } from "./auto-pair";
import { indentForNewLine, isBlankLine } from "./auto-indent";
import { scanMathRanges } from "../core/math-ranges";
import { scanNonMarkupRegions } from "../core/typst-lex";
import type { Region } from "../core/typst-lex";

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
 * 普通换行：新行沿用**上一行的缩进**（用户要求「换行时应该和上一行缩进一样」）。
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

/** 选区/光标是否触碰 Typst 中不按普通 markup 处理的区域。 */
function touchesOpaqueContext(
  from: number,
  to: number,
  doc: string,
  opaque: readonly Region[],
  math: readonly { from: number; to: number }[],
): boolean {
  // Lexer 为公式扫描也会记录 markup 直引号；字符串在 `#...` 代码里已包含于 code span。
  const markupRegions = opaque.filter((region) => region.kind !== "string");
  if (from !== to) {
    return [...markupRegions, ...math].some((range) => from < range.to && to > range.from);
  }
  if ([...markupRegions, ...math].some((range) => from >= range.from && from < range.to)) {
    return true;
  }

  // 代码区间按半开范围存储，但光标停在语句末尾（包括紧邻换行符前）仍应沿用普通换行。
  if (
    markupRegions.some(
      (region) => region.kind === "code" && from === region.to && region.from < region.to,
    )
  ) {
    return true;
  }

  // 行注释包含其行尾；块注释仅在未闭合时把 EOF 也算作注释内部。
  if (
    markupRegions.some((region) => {
      if (region.kind !== "comment" || from !== region.to) return false;
      const opener = doc.slice(region.from, region.from + 2);
      if (opener === "//") return true;
      if (opener !== "/*" || from !== doc.length) return false;
      let depth = 0;
      for (let i = region.from; i < from;) {
        if (doc.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (doc.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      return depth > 0;
    })
  ) {
    return true;
  }

  // 未闭合 raw/string 会延伸到 EOF；闭合定界符右侧仍是普通 markup。
  return markupRegions.some((region) => {
    if (from !== doc.length || region.to !== doc.length || from !== region.to) return false;
    if (region.kind === "raw" && doc[region.from] === "`") {
      let run = 1;
      while (doc[region.from + run] === "`") run++;
      return doc.indexOf("`".repeat(run), region.from + run) < 0;
    }
    return false;
  });
}

/**
 * 写作模式的普通 markup 换行：Enter 分段，Shift+Enter 写 Typst 显式换行符。
 * 代码/raw/注释/代码字符串/公式及源码模式继续走既有单换行逻辑；markup 直引号仍按正文处理。
 */
function newlineWithTypstSemantics(view: EditorView, softBreak: boolean): boolean {
  const { state } = view;
  if (state.readOnly) return false;

  const doc = state.doc.toString();
  const opaque = scanNonMarkupRegions(doc);
  const math = scanMathRanges(doc, opaque);
  view.dispatch(
    state.update(
      state.changeByRange((range) => {
        const line = state.doc.lineAt(range.from);
        const indent = indentForNewLine(line.text, range.from - line.from);
        const blank = range.empty && isBlankLine(line.text);

        // 空白行上沿用原有行为：清理残留缩进并增加一行，不写没有正文的 `\\`。
        if (blank) {
          const insert = state.lineBreak;
          return {
            changes: { from: line.from, to: line.to, insert },
            range: EditorSelection.cursor(line.from + insert.length),
          };
        }

        if (touchesOpaqueContext(range.from, range.to, doc, opaque, math)) {
          const insert = state.lineBreak + indent;
          return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.cursor(range.from + insert.length),
          };
        }

        // 当光标/选区正好到行尾时，已有的行分隔符可以参与构造：
        // Enter 在它前面再插一个换行，得到恰好两个换行；Shift+Enter 则把它改成 `\\\n`。
        const endsAtLineBreak =
          range.to === line.to &&
          state.doc.sliceString(line.to, line.to + state.lineBreak.length) === state.lineBreak;

        if (!softBreak) {
          // Enter = Typora 的新段落：用恰好两个换行替换行尾原有的一个，或在行中直接插入。
          // 光标落在新段落起点；接着打字不会落进空白分隔行里。
          const insert = state.lineBreak.repeat(2) + indent;
          const to = endsAtLineBreak ? range.to + state.lineBreak.length : range.to;
          return {
            changes: { from: range.from, to, insert },
            range: EditorSelection.cursor(range.from + insert.length),
          };
        }

        if (endsAtLineBreak) {
          // 复用已有换行，并保留下一行现有缩进；仅在下一行没有缩进时沿用本行缩进。
          const nextLine = state.doc.lineAt(line.to + state.lineBreak.length);
          const nextIndent = /^[ \t]*/.exec(nextLine.text)?.[0] ?? "";
          const continuationIndent = nextIndent.length === 0 ? indent : "";
          const insert = "\\" + state.lineBreak + continuationIndent;
          const from = range.from;
          const to = range.to + state.lineBreak.length;
          const caret = from + insert.length + (nextIndent.length > 0 ? nextIndent.length : 0);
          return {
            changes: { from, to, insert },
            range: EditorSelection.cursor(caret),
          };
        }

        // Shift+Enter = Typst line break (`\\` followed by a source newline and indentation).
        const insert = "\\" + state.lineBreak + indent;
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.cursor(range.from + insert.length),
        };
      }),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
  return true;
}

export interface EditorKeymapOptions {
  /**
   * 当前是不是**写作模式**（缺省 false = 源码模式）。
   *
   * 为什么需要它（报告 T5）：`codemirror-lang-typst/lezer` 自带
   * `typstLezerListKeymap`（`Prec.high`，Enter = `insertNewTypstListItem`、
   * Shift-Enter = `insertTypstListContinuation`），而本文件也导出 `Prec.high` 且**注册在前**
   * —— 同优先级下先返回 true 者胜出，于是那条 Enter 把列表命令整个遮住了（写作模式的列表里
   * 按回车不会续出下一项）。修法是**在写作模式先把列表命令调一遍**，它返回 false（不在列表里）
   * 才落回普通 Typst 换行处理；**不重写第二份列表 Enter 状态机**。
   */
  isWriteMode?: () => boolean;
}

/**
 * 写作模式的回车：先让依赖导出的列表命令处理，不认再按 Typst markup 语义换行。
 *
 * 依赖那条命令已经实现"同级拆项 / 空顶层退出 / 空嵌套项上移"，别再自己写一遍；
 * 它返回 false 的场合（光标不在列表项里）我们仍然要接管 —— 普通 markup 用段落/显式换行，
 * 其他上下文沿用上一行缩进（CM 默认的 `insertNewlineAndIndent` 在 typst 文档里时灵时不灵）。
 * 列表命令抛错也继续走普通换行处理：输入链路绝不能因为列表逻辑而吞掉按键。
 */
function listAwareEnter(
  isWriteMode: () => boolean,
  listCommand: Command,
  softBreak: boolean,
): (view: EditorView) => boolean {
  return (view) => {
    const writeMode = isWriteMode();
    if (writeMode) {
      try {
        if (listCommand(view)) return true;
      } catch (e) {
        console.error("[editor-keymap] 列表命令失败，退回普通换行：", e);
      }
    }
    if (!writeMode) return newlineKeepingIndent(view);
    return newlineWithTypstSemantics(view, softBreak);
  };
}

// CM6 中同一按键的多条绑定按注册顺序执行、先返回 true 者胜出，因此把自定义键位放在
// basicSetup 之后无法覆盖其默认绑定（例如 Mod-d 会被 searchKeymap 的"选中下一处"
// 在空选区时抢先返回 true）。用 Prec.high 提升优先级，保证自定义快捷键先被检查。
export function createEditorKeymap(opts: EditorKeymapOptions = {}) {
  const isWriteMode = opts.isWriteMode ?? (() => false);
  return Prec.high(
    keymap.of([
      indentWithTab, // Tab 缩进 / Shift+Tab 反缩进
      {
        key: "Enter",
        run: listAwareEnter(isWriteMode, insertNewTypstListItem, false),
        preventDefault: true,
      },
      {
        key: "Shift-Enter",
        run: listAwareEnter(isWriteMode, insertTypstListContinuation, true),
        preventDefault: true,
      },
      { key: "Backspace", run: deleteEmptyDollarPair, preventDefault: true }, // 空配对整对删
      { key: "Mod-Shift-d", run: copyLineDown, preventDefault: true }, // 复制当前行到下方（VS Code 语义）
      { key: "Mod-d", run: deleteLine, preventDefault: true }, // 删除当前行（有意覆盖 searchKeymap 的"选中下一处"）
      { key: "Mod-Shift-/", run: toggleBlockComment, preventDefault: true }, // 块注释
      { key: "Mod-/", run: toggleComment, preventDefault: true }, // 行注释（Ctrl+/ 切换）
    ]),
  );
}

/** 源码模式（不碰列表语义）的键位；写作模式用 `createEditorKeymap({ isWriteMode })` */
export const editorKeymap = createEditorKeymap();
