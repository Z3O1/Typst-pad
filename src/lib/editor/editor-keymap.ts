// 自定义编辑快捷键绑定：在 basicSetup 默认键位之外补充的编辑器快捷键
import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { EditorSelection, Prec } from "@codemirror/state";
import { acceptCompletion } from "@codemirror/autocomplete";
import { ensureSyntaxTree, language } from "@codemirror/language";
import {
  indentLess,
  indentMore,
  deleteLine,
  copyLineDown,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import type { Command } from "@codemirror/view";
import { insertNewTypstListItem, insertTypstListContinuation } from "codemirror-lang-typst/lezer";
import { emptyPairBackspace, planScaffoldExpand } from "./auto-pair";
import { addDollarPair } from "./dollar-pair-state";
import { indentForNewLine, isBlankLine } from "./auto-indent";
import { scanMathRanges } from "../core/math-ranges";
import { scanNonMarkupRegions } from "../core/typst-lex";
import type { Region } from "../core/typst-lex";
import { defaultSettings } from "../core/app-settings";

/**
 * 退格删掉空 $$；空行间公式先缩回 $$，下一次才删除定界符。
 * 不接管时返回 false，keymap 会继续往下找 basicSetup 的默认退格（不会丢功能）。
 * 删除范围由 emptyPairBackspace 给（**光标两侧各删几个**，行间脚手架是跨在光标两侧的），
 * 所有光标都匹配才接管（与 CM deleteBracketPair 一致），混合情况交回默认退格。
 */
function deleteEmptyDollarPair(view: EditorView): boolean {
  const { state } = view;
  if (state.readOnly || view.composing || view.compositionStarted) return false;
  const doc = state.doc.toString();
  const syntax = ensureSyntaxTree(state, state.doc.length, 20);
  if (!syntax && state.facet(language)) return false;
  const tree = syntax?.topNode.name === "Typst" ? syntax : undefined;
  let complete = true;
  const changes = state.changeByRange((range) => {
    const span = range.empty ? emptyPairBackspace(doc, range.head, tree) : null;
    if (!span) {
      complete = false;
      return { range };
    }
    const from = range.head - span.before;
    const to = range.head + span.after;
    const compact = doc[from - 1] === "$" && doc[to] === "$" && !doc.slice(from, to).includes("$");
    return {
      changes: { from, to },
      range: EditorSelection.cursor(from),
      effects: compact ? addDollarPair.of({ open: from - 1, close: from, display: false }) : [],
    };
  });
  if (!complete) return false;
  view.dispatch(
    state.update(changes, {
      scrollIntoView: true,
      userEvent: "delete.backward",
    }),
  );
  return true;
}

/** Tab 直接插入的字符 = 一个制表符（tabSpaces=0 时的回退；默认 2 空格，见 tabUnit） */
const TAB_CHAR = "\t";

/**
 * Tab 一档插的字符 = **设置里的空格数**（`tabSpaces`，0 = 制表符，2026-10-07 起可配置；
 * 默认 2 空格，旧行为「插一个 \t」= 把设置调成 0）。
 * 每次按键现取现算：设置保存后下一次 Tab 就生效，键位扩展不用重建（同 isWriteMode）。
 */
function tabUnit(tabSpaces: number): string {
  return tabSpaces === 0 ? TAB_CHAR : " ".repeat(tabSpaces);
}

/**
 * 给选区触碰的每一行行首加**一档**（用户：「选中了一些东西 → 把这些东西所在的行之前一个 tab」；
 * 一档 = 设置里的 tabSpaces，0 = 制表符，见 tabUnit）。
 *
 * 行的口径与 CM `indentMore` 的 `changeBySelectedLine` 一致：选区**到达**的行都算，包括
 * 选区结尾正好停在某行行首的那一行；同一行被多个选区触碰只加一次。选区锚点/头部按
 * assoc=1 映射，落在新插入的一档之后 —— 与 `indentMore`（Ctrl+Tab）的选区保持同款。
 * 这里不复用 `indentMore`：那一档插的是 `indentUnit`（4 个空格），而 Tab 语义由 tabSpaces 定。
 */
function indentLinesWithTab(view: EditorView, unit: string): boolean {
  const { state } = view;
  const seen = new Set<number>();
  const changes: { from: number; insert: string }[] = [];
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        changes.push({ from: line.from, insert: unit });
      }
      pos = line.to + 1;
    }
  }
  if (changes.length === 0) return false;
  changes.sort((a, b) => a.from - b.from); // 多选区可能乱序，变更按位置升序交给 CM
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.create(
      state.selection.ranges.map((range) =>
        EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1)),
      ),
      state.selection.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "input.indent",
  });
  return true;
}

/**
 * Tab = **补全候选开着先接受所选候选**（公式里的 `typstMathCompletions` 等都是 CM 补全面板，
 * 用户要求「有候选时 Tab 等于输入所选候选」）；否则有选区给触碰的行前各加一档，
 * 无选区直接插入一档（tabSpaces 个空格，0 = 一个制表符）。
 */
function insertTabOrIndentLines(view: EditorView, unit: string): boolean {
  if (view.state.readOnly) return false;
  if (acceptCompletion(view)) return true;
  if (view.state.selection.ranges.some((range) => !range.empty)) {
    return indentLinesWithTab(view, unit);
  }
  view.dispatch(
    view.state.update(view.state.replaceSelection(unit), {
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
}

/**
 * Shift+Tab = Tab 的**逆操作**（2026-10-07 随 tabSpaces 设置引入，与 Tab 对称，行口径同
 * indentLinesWithTab）：行首是制表符就删那一个制表符；否则删一档空格（tabSpaces 个，
 * 不够就删到行首空白尽头）；没有行首缩进的行原样跳过。
 *
 * 为什么不再直接绑 CM `indentLess`：它按 `indentUnit`（4 列）退，与 Tab 插入的档宽不一致 ——
 * tabSpaces=2 时连按两次 Tab 缩进到第二层，一次 indentLess 会吃掉两层（实测 4 列全删）。
 * `Ctrl+Shift+Tab` 仍保留 `indentLess`：它与 `Ctrl+Tab`（indentUnit 四空格）配对，语义没变。
 * tabSpaces=0（制表符模式）时空格行按 4 列退 —— 与旧行为（indentLess 按 tabSize=4）一致。
 */
function dedentTabUnit(view: EditorView, tabSpaces: number): boolean {
  if (view.state.readOnly) return false;
  const unit = tabSpaces > 0 ? tabSpaces : 4;
  const { state } = view;
  const seen = new Set<number>();
  const changes: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        const lead = /^[ \t]*/.exec(line.text)?.[0] ?? "";
        if (!lead) {
          pos = line.to + 1;
          continue; // 行首无缩进：没东西可退
        }
        // 行首制表符 = 一整档（无论 tabSpaces 取多少，删半个制表符没有意义）；否则退一档空格
        const removeLen = lead.startsWith("\t") ? 1 : Math.min(unit, lead.length);
        changes.push({ from: line.from, to: line.from + removeLen });
      }
      pos = line.to + 1;
    }
  }
  if (changes.length === 0) return true; // 全是无缩进行：吃掉按键但不发空事务
  changes.sort((a, b) => a.from - b.from);
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.create(
      state.selection.ranges.map((range) =>
        EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1)),
      ),
      state.selection.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "delete.dedent",
  });
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
  /**
   * Tab 一档插几个空格（0 = 制表符）。缺省 = 默认值 2（见 app-settings.defaultSettings）。
   * 用 getter 而不是定值：设置保存后不重建键位扩展，下一次 Tab 就生效（同 isWriteMode）。
   */
  tabSpaces?: () => number;
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

/**
 * 光标在**独占一行的空配对** `$$` 或空行间脚手架 `$  $` 内部时，Enter 展开成三行：
 * `$` / 一档 / `$`（一档 = `tabUnit(tabSpaces)`，与 Tab 键的档宽联动；
 * 设置 0 时就是制表符）。光标落中行一档之后，接着打字就写在公式里。
 *
 * 与 `auto-pair.planScaffoldExpand`（判定）配套，这里是落事务的那一半；
 * 不匹配（选区非空、多光标、非脚手架行）返回 false 交回常规 Enter 链路
 * （列表命令 → 段落/续行换行），模式无关、两套模式都能展开。
 */
function expandMathScaffold(view: EditorView, tabSpaces: number): boolean {
  if (view.state.readOnly || view.composing || view.compositionStarted) return false;
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const syntax = ensureSyntaxTree(state, state.doc.length, 20);
  if (!syntax && state.facet(language)) return false;
  const tree = syntax?.topNode.name === "Typst" ? syntax : undefined;
  const plan = planScaffoldExpand(
    state.doc.toString(),
    state.selection.main.head,
    state.lineBreak,
    tabUnit(tabSpaces),
    tree,
  );
  if (!plan) return false;
  const insert = state.toText(plan.insert);
  const caret = plan.from + state.toText(plan.insert.slice(0, plan.caret - plan.from)).length;
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert },
    selection: { anchor: caret },
    effects: addDollarPair.of({
      open: plan.from,
      close: plan.from + insert.length - 1,
      display: true,
    }),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

// CM6 中同一按键的多条绑定按注册顺序执行、先返回 true 者胜出，因此把自定义键位放在
// basicSetup 之后无法覆盖其默认绑定（例如 Mod-d 会被 searchKeymap 的"选中下一处"
// 在空选区时抢先返回 true）。用 Prec.high 提升优先级，保证自定义快捷键先被检查。
export function createEditorKeymap(opts: EditorKeymapOptions = {}) {
  const isWriteMode = opts.isWriteMode ?? (() => false);
  // 未传 getter 时（源码模式的 editorKeymap 导出、单测直建）回落 app-settings 的唯一默认源
  const tabSpaces = opts.tabSpaces ?? (() => defaultSettings().tabSpaces);
  // Enter 的完整链路：空脚手架展开（新，最优先）→ 列表命令 → 段落/续行换行。
  // 展开不匹配时必须交回原链路，所以包成一层而不是拆开 listAwareEnter。
  const enterWithScaffold = (view: EditorView): boolean =>
    expandMathScaffold(view, tabSpaces()) ||
    listAwareEnter(isWriteMode, insertNewTypstListItem, false)(view);
  return Prec.high(
    keymap.of([
      // **Tab / Shift+Tab**（2026-09-28 接管普通 Tab；2026-10-07 档宽改为设置项 tabSpaces）：
      // - 补全候选开着 → 先接受所选候选（公式里的 `typstMathCompletions` 等，见 insertTabOrIndentLines）；
      // - 有选区 → 给选区触碰的每一行行首各加一档（indentLinesWithTab；一档 = tabSpaces 个空格，0 = 制表符）；
      // - 无选区 → 直接插入一档（tabUnit）。
      // Shift+Tab 是 Tab 的逆操作（dedentTabUnit：删行首一档），按 tabSpaces 而非 indentUnit 退，
      // 保证按几下 Tab 就能按几下 Shift+Tab 原路退回。
      // `preventDefault: true` 与本文件其它自定义键位同款：命令返回 false（只读文档）时也吃掉按键。
      {
        key: "Tab",
        run: (v) => insertTabOrIndentLines(v, tabUnit(tabSpaces())),
        preventDefault: true,
      },
      { key: "Shift-Tab", run: (v) => dedentTabUnit(v, tabSpaces()), preventDefault: true },
      // 缩进 / 反缩进（按 indentUnit = 4 个空格的一档）仍是 **Ctrl+Tab / Ctrl+Shift+Tab**
      // （2026-09-28 上午从 Tab 改到 Ctrl+Tab；同日普通 Tab 又按新需求接管，见上）。
      //
      // 为什么写 `Ctrl-` 而不是本文件其它键位用的 `Mod-`：macOS 上 Mod = Cmd，而 Cmd+Tab 是系统
      // 切换应用、根本到不了页面（Ctrl+Tab 在 Windows / macOS 两边都空着）。桌面版能收到它是因为
      // 浏览器加速键已在 Rust 侧关掉（见 src-tauri/src/lib.rs 的 DisableBrowserAccelerators）；
      // **真实浏览器里 Ctrl+Tab 是浏览器级手势、页面收不到**，所以这条只能在桌面版与浏览器验收的
      // 注入事件（CDP）里验，别指望在 Chrome 里手按。
      { key: "Ctrl-Tab", run: indentMore, preventDefault: true },
      { key: "Ctrl-Shift-Tab", run: indentLess, preventDefault: true },
      {
        key: "Enter",
        run: enterWithScaffold,
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
