# 写作模式的可编辑子集

[返回文档索引](../README.md) · 呈现模型见[写作渲染](writing-rendering.md)、[所见即所得](wysiwyg.md)，
取舍背景见[渲染模型](../design/rendering-model.md)。

源码始终是唯一文档状态。一个块只有**同时**满足下面四条，才获得原位编辑资格（编辑器里以真实文本呈现，
而不是 Typst 切片）：

1. **`syntax`**：源码结构在白名单内 —— 段落/标题，或单源码行、顶格的简单列表项；
2. **`text`**：**呈现文字已被证明能唯一对应回这段源码**（后端证明，见下）；
3. **`geometry`**：引擎确实画了这一块、没有被有意跳过（`found && !skipped && heightPt > 0`）；
4. **`fresh`**：证明里带的源码与当前文档的同一区间**逐字相同** —— 为旧文档算出的产物不给新文档授权。

资格属于**当前编译结果**，不是 AST 类型的永久属性：同一个 `Paragraph`，只要 show rule 换了字、
宏在使用处展开、或产物过期，就不再可编辑。无法证明时一律退回切片；编译失败、结果过期或没有可靠切片时
按现有规则显示源码。**不得**根据"视觉上像文字"就开放直接编辑。

## 决策接口（唯一判据）

`src/lib/core/editable-subset.ts` 的 `decideTextBlockEditing` 是纯函数，只做决策、不碰 CodeMirror；
块级装饰（`live-preview/block-decorations`）只消费它的结论，不另写一套语法判据。返回值四个信号各自独立，
外加 `editable` 与机器可读的 `reason`：

| 信号 | 取值 | 来源 |
| --- | --- | --- |
| `syntax` | `simple` / `unsupported` | 前端 lexer（`typst-lex`）+ 结构性判据 |
| `text` | `verified` / `unknown` / `no-proof` | 后端 `BlockCrop.edit`（`no-proof` = 旧后端没这个字段） |
| `geometry` | `ok` / `missing` | 块表（`found` / `skipped` / `heightPt`） |
| `fresh` | `true` / `false` | `edit.source === doc.slice(block.from, block.to)` |

**旧后端 / 只给几何的桩**不发 `edit`：前端按 `no-proof` 走旧的语法判据（保持历史行为）；
**新后端**一定发 `edit`，于是"证不出来"（`unknown`）会真的退回切片 —— 两者必须分得开，
否则反例（换字 / 宏展开 / 重复输出）会被"缺字段"的兜底洗成可编辑。

## 后端文字对应证明

`src-tauri/src/block_geometry/text_proof.rs` 的 `prove_block_text` 只依赖**帧里的字形几何**与源码字节，
不重新解析语法（避免与前端两套判据漂移）。`verified` 要求：

1. 与块区间相交的字形**全部落在块内**（跨块 / 来自别处 ⇒ `straddle`）；
2. 全部同页、且落在这一块的裁剪带里（脚注正文被排到页底、`#place` 挪走的墨迹 ⇒ `out-of-band`）；
3. 源码起点**严格互不相同**（重复输出 ⇒ `duplicate`）；**非原子**字形按阅读顺序（基线聚类 + 横向）
   源码区间严格递增且不重叠（乱序 ⇒ `order`）；
4. 块内**字母数字字符**（含 CJK）必须被某个字形覆盖（被丢掉 / 替换 ⇒ `gap` / `partial`）；
5. 这一块的带里没有**别的来源**的墨迹（其它块 ⇒ `intrusion`；`#include` 进来的文件 ⇒ `foreign-ink`）。

证明里带 `source`（编译时这一块的源码文本），前端逐字比对当前区间 —— 这就是 `fresh`。

### 豁免区间（`SourceBlock::atoms`）

有些源码段**不由逐字符排版负责**，证明不要求它们逐字符有字形，范围取自**语法树**（`exempt_ranges`）：

- **原子**：`Equation`（行内/行间公式，前端按同一段源码单独编译成 widget）、`Label`（不画）、
  `Ref`（画成编号/文献）、`Raw`（行内代码文本）；
- **行内函数调用的语法部分**：`#` + `FuncCall` 的**函数名与括号**（`#strong[` 的 `#strong`），
  但**内容块照常逐字检查** —— `#show strong: it => [替换]` 换掉内容时必须证不出来。

第 4 条判据只对"字母数字"严格：标点、空白、`*`/`=`/`$` 这类语法符允许没有字形。

### 判据之外的两条工程约束

- **字形 `Span` 的 `FileId`**：只有主文档的字形进 `items`；`#include` 进来的文件里的字形进
  `FrameStats::foreign_ink`（早先不区分 `FileId`，别的文件里的字节偏移被当主文档坐标，污染块几何与命中）。
  `span` 为 `None` 的是 **typst 自己合成的字形**（列表符号 `•`/`1.`、`dif` 的 "d"、`integral` 的上下限），
  属于本块内容：既不算外来，也不参与覆盖。
- **列表标记**：`list_marker_of` 从合成字形里取出 typst **实际画出的**符号（`•` / `1.` / `a)`）与
  **正文起点偏移**，随 `BlockCrop.listMarker` 一起发。前端用 `ListMarkerWidget` 按这个偏移画右对齐的
  定宽盒子，符号/缩进/编号与 typst 完全一致。取不到时（如 `#set list(marker: [--])`，标记字形指回
  定义处）返回缺省 ⇒ 列表项不开放。

## 现状：已实现 / 保守回退 / 待研究

| 语法 | 状态 | 说明 |
| --- | --- | --- |
| 单源码行正文、标题 | **已实现** | 证明 `verified` 即直接编辑；段内单 LF 仍整段切片 |
| `*strong*` / `_emph_` | **已实现** | 标记隐藏、正文加样式，证明不受影响 |
| 简单列表项 `- `/`+ ` | **已实现** | 单源码行、顶格、**引擎给了标记**、证明 `verified`、**正文不含行内公式**才开放；嵌套/多行/自定义 marker/含公式的项切片 |
| 行内公式 `$…$` | **已实现** | 公式是原子：前后正文照常编辑，公式由独立 widget 呈现 |
| `<label>` / `@ref` | **保守回退** | 标签/引用是原子，不再阻塞整块资格；引用目前仍以源码形态显示（见下"待研究"） |
| 行内 raw、链接 | **保守回退** | 前端把含 raw/link 的块判为复杂 ⇒ 切片（与历史行为一致） |
| `#strong[文字]` / `#emph[文字]` | **已实现** | 简单函数白名单：隐藏 `#strong[` 与 `]`、正文加样式；其它 `#…` 一律切片 |
| `#text(...)` 等其它内建函数 | **待研究** | 未开放；后端已豁免调用语法，但前端白名单不放行（切片） |
| `/ 术语: 解释` | **待研究** | 术语项的布局与区间规则未验证，暂不并入普通列表判据 |
| 脚注 `#footnote[…]` | **保守回退** | 正文被排到页底 ⇒ 证明 `out-of-band` ⇒ 切片（源码模式可查看） |
| 表格 / 图片 / 图注 | **待研究** | 见下节「任务 5」 |

### 已知边界与理由

- **`@ref` 仍以源码形态显示**：Typst 把引用画成编号/文献，前端无法把编号可靠映射回 `@key` 的
  补充内容（`@key[p.~7]`）。为了不实现"改排版结果再逆向生成 Typst"，这一阶段不给引用做独立呈现；
  它在块里是原子（不阻塞资格），显示的是源码形态 —— 与[写作渲染](writing-rendering.md)的既有说明一致。
- **含行内 raw / 链接的块**仍整块切片：raw 用 CSS 近似等宽、链接隐藏 `#link("url")`，两者都还没有
  "点击进入局部源码 + 选区覆盖 + 编辑后失效"的完整规则（任务 3 的待办）。
- **合并成多源码行的列表项**（typst 把子列表/换行正文放进同一个 `ListItem` 节点）不开放：逐源码行呈现
  必然多出行盒。列表标记本身仍由引擎提供，切片外观与 typst 一致。
- **含行内公式的列表项**不开放（PKU 实测两块不一致后收窄）：列表的正文列更窄，而 Typst 会在行内公式
  内部折行、浏览器把公式当原子 widget。引擎断点落在公式里时前端按既有规则**整块不折**
  （见 `buildEngineBreakDecorations`），于是折行数对不上；另有单行情形下浏览器在 CJK 边界多折一行
  （`white-space: pre` 不阻止这类折行）。这类项保持切片——切片就是 Typst 的真排版。
- **列表标记的取法**：按"标记盒与正文之间的横向间距"（`marker_width + body_indent`，默认 0.5em）
  断开，正文起点在断开处之后重算。**不能只看"在第一个主文档字形左边"**：公式里 typst 合成的字形
  也在那里（PKU L101 因此把 `𝛼𝛼𝛼` 当成标记、正文起点算到 64pt）。标记用伪元素画、不进文本层，
  免得给"按基线条数数视觉行"多算一条基线。

## 反例测试（任务 0 / 1）

先建能**推翻**资格判据的反例，再看正常案例。Rust 侧（真实后端）见
`src-tauri/src/block_geometry/tests/proof.rs`；前端（纯决策 + 编辑器集成）见
`src/lib/core/editable-subset.test.ts`、`src/lib/editor/live-preview/block-decorations.test.ts`、
`list-marker.test.ts` 与 `inline-calls.test.ts`。

| 反例 | 期望 | 主要断言位置 |
| --- | --- | --- |
| 纯文字 / 标题 / 强调 | 可编辑 | `plain_text_blocks_are_verified` |
| 只改样式的 show rule | 可编辑 | `styling_only_show_rule_keeps_verification` |
| 替换文字型 show rule | 切片 | `text_replacing_show_rule_is_unknown` |
| 同一源码输出两次 | 切片 | `duplicated_output_is_unknown` |
| 宏生成文字（`#let` 在使用处展开） | 切片 | `macro_generated_text_is_unknown` |
| `#include` 其它源文件 | 不误认 | `foreign_file_glyphs_are_not_attributed_to_main_doc` |
| 脚注 / `#place` 挪出裁剪带 | 切片 | `footnote_body_out_of_band_is_unknown` |
| 旧结果套新文档 | 不可编辑 | `editable-subset.test.ts` 的 `text-stale` 用例 |
| 白名单函数内容被 show rule 换掉 | 切片 | `whitelisted_function_replaced_by_show_rule_is_unknown` |
| 自定义列表 marker / 编号 / 起始值 | 引擎值或切片 | `custom_numbering_and_start_use_engine_values` |
| 宏字形指回 `#let` 定义处 | 不误判为外来墨迹 | `macro_glyph_pointing_at_definition_is_not_foreign_intrusion` |
| 公式内部同源字形 | 不误判为重复输出 | `repeated_math_source_ranges_are_not_duplicate_output` |
| `#strong[文字]` 调用语法隐藏、正文可编辑 | 直接编辑 | `inline-calls.test.ts` |
| 非白名单函数 / 白名单内容夹带代码 | 切片 | `editable-subset.test.ts`、`hasNonWhitelistedCode` |

## 浏览器验收

真实产物夹具（`npm run fixtures:blocks`）+ 浏览器：`writing-blocks-visual.mjs` 与
`writing-mode-scenes.mjs` 用 `harness.mjs` 的 `editableInFixture`（与本节决策同口径，独立实现）
算出"哪些块该是切片"，再断言页面里的 `.cm-block-crop` 集合与之**逐块一致**；
`writing-blocks.mjs` 另外验"简单列表项是真实文本、列表标记取自引擎（符号 + 正文起点宽度、
`border-box` 盒）"与"点击嵌套列表切片会展开源码"。列表标记的位置/宽度换算（pt → px × 4/3）
在 `list-marker.test.ts` 与 `inline-calls.test.ts` 用真视图钉住。

`editableInFixture` 必须与 `core/editable-subset` 一起改：它是**独立**实现，两边不一致时套件会红
—— 这正是它要抓的"前端与决策漂移"；但它只读夹具自带的字段，不会重算后端的证明。

**PKU 真实作业验收**（`PKU_ROOT="$HOME/PKU" npm run verify:pku-writing`，2026-09-25 本轮）：
**76/76 全部通过**。四份作业的可编辑正文共 **236 块**（103/49/17/67）全部走带高盒、视觉行数与
Typst **逐块一致（0 块不一致）**，同页相邻锚点越界 0 处、页内累计越界 0 处，切片集合与期望逐块一致
（25/7/18/41）。其中 327 个源块里只有 1 个文字证明为 `unknown`（一张 `#table(...)`，本就该切片）。

## 任务 3 / 5：设计与拆分

行内原子（任务 3）与有限结构化编辑（表格 / 图片属性 / 图注 / 引用选择器，任务 5）的**可改源码子集、
交互与验收条件**见[结构化编辑设计](../design/structured-editing.md)。那是一份**提案**，只有标「已实现」
的条目才在产品里生效；本节只记当前状态与保守回退理由。

当前（任务 3 的已落地部分）：

- 引用 `@key`、标签 `<label>` 是原子，**不阻塞**所在段落/标题的资格；引用仍以源码形态显示。
- 脚注 `#footnote[…]` 的正文被排到页底 ⇒ 证明 `out-of-band` ⇒ 整块切片。
- 行内 raw 与链接仍整块切片：呈现来源、局部揭示与选区覆盖规则还没定义完（见设计文档）。
