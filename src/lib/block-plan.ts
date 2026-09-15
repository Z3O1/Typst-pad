// 写作模式的块级渲染：**规划**（纯函数，可单测）。
//
// 形态（见 docs/文档模式渲染保真-调研.md 第三节）：整篇编译一次 → 每个源块在版面上的那一块
// 被切成一张 SVG → 编辑器里"非光标所在块"用 widget 显示这张切片，"光标所在块"保持源码。
//
// 本模块只做决策，不碰 CodeMirror：把"块表 + 当前选区 + 文档长度"算成
// "哪些区间要被 widget 覆盖"，落成装饰由 live-preview.ts 负责。
import type { Text } from "@codemirror/state";
import type { BlockCrop } from "./typst-engine";
import { byteOffsetsToPositions } from "./block-offsets";

/** 版本快照用：同一次编译产出的文档文本（用来判断块表是否已过期） */
export interface BlockTable {
  /** 生成这张表时的**文档原文**（编辑器内容，不含编译前缀） */
  doc: string;
  blocks: Block[];
}

/** 已换算成 CodeMirror 位置的块 */
export interface Block {
  /** 块自身的源码范围（文档坐标，CodeMirror 位置） */
  from: number;
  to: number;
  kind: string;
  /** 是否有渲染结果（`#let` / `#show` / 纯注释行没有） */
  found: boolean;
  /** 切片 SVG；空串 = 没有渲染结果 */
  svg: string;
  widthPt: number;
  heightPt: number;
  /** 内容分布在几页（单张长页为 1） */
  pages: number;
  /** 切片所在页（1-based）与裁剪带在页面上的原点（pt）—— 点击定位用，见 block-hit.ts */
  page: number;
  xPt: number;
  yPt: number;
}

/**
 * Rust 侧 `compile_blocks` 的产物 → 前端块表。
 *
 * 两级换算都在这里做完：
 * 1. 字节偏移 → UTF-16 位置（`byteOffsetsToPositions`，一次性扫全文）；
 * 2. 越界 / 反序的块直接丢弃（编译期间文档又变了时可能出现，宁可少渲染不可乱渲染）。
 */
export function toBlockTable(
  doc: string,
  raw: Pick<
    BlockCrop,
    "start" | "end" | "kind" | "found" | "svg" | "widthPt" | "heightPt" | "pages" | "page" | "xPt" | "yPt"
  >[],
): BlockTable {
  const offsets: number[] = [];
  for (const b of raw) {
    offsets.push(b.start, b.end);
  }
  const positions = byteOffsetsToPositions(doc, offsets);
  const blocks: Block[] = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    const from = positions[i * 2];
    const to = positions[i * 2 + 1];
    if (from >= to || to > doc.length) continue; // 越界/空块：丢掉（下次编译会补回来）
    if (blocks.length > 0 && from < blocks[blocks.length - 1].to) continue; // 必须递增不重叠
    blocks.push({
      from,
      to,
      kind: b.kind,
      found: b.found === true,
      svg: typeof b.svg === "string" ? b.svg : "",
      widthPt: b.widthPt,
      heightPt: b.heightPt,
      pages: b.pages ?? 1,
      page: typeof b.page === "number" && b.page > 0 ? b.page : 1,
      xPt: typeof b.xPt === "number" ? b.xPt : 0,
      yPt: typeof b.yPt === "number" ? b.yPt : 0,
    });
  }
  return { doc, blocks };
}

/**
 * 窗口化渲染下的"沿用上一轮切片"（纯函数）。
 *
 * 背景（实测，见 `dump_long_doc_blocks`）：逐块 SVG 会各自复制一份字形轮廓，约
 * **58 字节/源字符** —— 2 万字符文档全渲一次 11.7MB、debug 下 3.7s，而这是**每按键一次**的
 * 开销。所以编译只渲视口窗口内的块（窗口外 `svg` 为空），其余块沿用上一轮结果：
 * 只要这个块的**源码文本没变**，它的排版结果就照旧可用（编号/交叉引用这类全文档状态变化
 * 不在此列 —— 与公式缓存的取舍一致，属已知代价）。
 *
 * 匹配键 = 块类型 + 源码文本：位置会随编辑漂移，文本才是"还是不是同一块"的判据。
 */
export function carryOverCrops(
  prev: readonly Block[] | null,
  next: readonly Block[],
  doc: string,
): { blocks: Block[]; carried: number; missing: number } {
  if (next.length === 0) return { blocks: [], carried: 0, missing: 0 };
  const cache = new Map<string, string>();
  if (prev) {
    for (const b of prev) {
      if (!b.svg) continue;
      cache.set(`${b.kind}\u0000${doc.slice(b.from, b.to)}`, b.svg);
    }
  }
  let carried = 0;
  let missing = 0;
  const blocks = next.map((b) => {
    if (b.svg) return b;
    const reused = cache.get(`${b.kind}\u0000${doc.slice(b.from, b.to)}`);
    if (reused) {
      carried++;
      return { ...b, svg: reused };
    }
    missing++;
    return b;
  });
  return { blocks, carried, missing };
}

/** 一个块在编辑器里被"覆盖"的区间（= 它前面的空白 + 块自身） */
export interface BlockCover {
  block: Block;
  /**
   * 被 widget 覆盖的起点 = **上一块的源码终点**（首块为 0）。
   * 也就是把"块与块之间的空行"一并交给下面这一块的 widget —— 见 planBlockCovers 的说明。
   */
  coverFrom: number;
  /** 被 widget 覆盖的终点 = **本块的源码终点**（末块延伸到文档末尾） */
  coverTo: number;
  /** 该块是否可渲染（有 SVG 且高度为正） */
  renderable: boolean;
  /** 是否展开源码（光标/选区落在它这一格，或它根本没法渲染） */
  revealed: boolean;
}

/**
 * 给块表算"覆盖格"：**每块一格，格子首尾相接铺满全文**（`cover_i.to === cover_{i+1}.from`）。
 *
 * **格子必须落在整行边界上**（这是 CodeMirror 的硬要求，也是实测踩出来的坑）：
 * 块 widget 是 `Decoration.replace({block: true})`，而"块级替换"要求区间整行对齐 ——
 * 只给"块最后一个字符"当终点时，CM 既插入了 widget **又保留了原文**（真实浏览器验收
 * `writing-blibcks` 抓到：切片在、正文也还在）。仓库里既有的数学块 widget 同样是整行
 * 范围（`first.from .. last.to`，见 live-preview.blockRangeFor）。
 *
 * 格子吃掉的是**块尾的空行**（块与块之间的空行归上一块），于是：
 *  - 格子铺满全文、首尾相接 ⇒ 永远恰好有一块是源码形态，光标不会无处可去；
 *  - 排版里的段落间距已经算进切片高度（相邻块各分到一半间距），空行若再单独占一行
 *    就会叠出多余空白，摞起来就不等于原版式。
 *
 * 不可渲染的块（`#let` / `#show` / 注释行）保持可见、永不被 widget 覆盖。
 */
export function planBlockCovers(blocks: readonly Block[] | null, doc: Text): BlockCover[] {
  if (!blocks || blocks.length === 0) return [];
  const covers: BlockCover[] = [];
  /** 块的最后一行行号（`to` 落在行首时取上一行） */
  const lastLine = (b: Block) =>
    doc.lineAt(Math.max(b.from, Math.min(b.to, doc.length) - 1)).number;
  /** 块之后那一行的起点 = 这一格该盖到哪儿（到文档末尾就是末尾） */
  const afterLastLine = (b: Block) => {
    const n = lastLine(b) + 1;
    return n > doc.lines ? doc.length : doc.line(n).from;
  };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const coverFrom = i > 0 ? afterLastLine(blocks[i - 1]) : 0;
    const coverTo = i + 1 < blocks.length ? afterLastLine(block) : doc.length;
    covers.push({
      block,
      coverFrom,
      coverTo,
      renderable: block.found && block.svg !== "" && block.heightPt > 0.5,
      revealed: false, // 由 applyBlockSelection 填入
    });
  }
  return covers;
}

/**
 * 按当前选区决定"哪一格展开源码"（就地改 revealed；返回是否有变化）。
 *
 * 规则：**选区触碰到的格子全部展开**（空选区时就是光标所在的那一格）。多选区（多光标）
 * 下会展开多格 —— 多展开只是多显示一点源码，永远是安全方向。
 *
 * 因为格子铺满全文，光标**永远**落在某一格里 ⇒ 永远恰好有一块是源码形态、有地方可编辑
 * （这条对"整篇都被 widget 盖住之后光标无处可去"是硬约束）。
 */
export function applyBlockSelection(
  covers: BlockCover[],
  selections: readonly { from: number; to: number }[],
  docLength = Number.POSITIVE_INFINITY,
): boolean {
  let changed = false;
  /**
   * 光标在格子边界上时**只展开后面那一格**（格子按半开区间 [coverFrom, coverTo) 判）：
   * 整行对齐之后相邻格子在行首共享边界，若两端都算命中，点一下段落开头会把上一段也展开。
   * 文档末尾是唯一的例外（那里没有"后面那一格"）。
   */
  const touches = (cover: BlockCover, sel: { from: number; to: number }): boolean => {
    if (sel.from === sel.to) {
      return (
        sel.from >= cover.coverFrom &&
        (sel.from < cover.coverTo || cover.coverTo === docLength)
      );
    }
    return sel.from < cover.coverTo && sel.to > cover.coverFrom;
  };
  for (const cover of covers) {
    const hit = !cover.renderable || selections.some((sel) => touches(cover, sel));
    if (hit !== cover.revealed) {
      cover.revealed = hit;
      changed = true;
    }
  }
  // 一格都没命中（选区越界 / 文档为空）时兜底展开第一格：永远留一个可编辑的位置
  if (covers.length > 0 && !covers.some((c) => c.revealed)) {
    covers[0].revealed = true;
    changed = true;
  }
  return changed;
}

/**
 * **跨块竖直移动的落点**（ArrowUp / ArrowDown / PageUp / PageDown 用）。
 *
 * 为什么需要自己算：CodeMirror 的竖直移动（`moveVertically`）是从光标往上/下逐像素扫，
 * 找到**文本行**才停 —— 而它的扫描会**跳过所有非文本块**（widget，见 `posAtCoords`：
 * `if (block.type != BlockType.Text) { yOffset = block.top - halfLine; continue }`）。
 * 写作模式的切片全是 widget，于是"往上"时它会一路跳过所有切片、扫到内容顶部，
 * 然后返回**位置 0** —— 用户看到的就是「在 `== 6` 前面按上，跳回文档开头」（实测复现）。
 *
 * 规则（阶段 2 起按"视觉上的下一块"判定，不再按格子）：
 *  - 默认结果**仍在当前块的正文里**（多行块内逐行移动）→ 不接管，交回 CodeMirror；
 *  - 一旦会走到块外（含格子那一圈"块前后的空行"）→ 接管，落到相邻块**正文**的边界上：
 *    向下 = 下一块的 `block.from`（下一段正文的开头，而不是格子里那条空行）、
 *    向上 = 上一块的末字符。
 *
 * 为什么要看 `block` 而不是 `cover`：格子为了吃掉块前的空行会往前扩一圈，于是"往下走一格"
 * 会先落在两个段落之间那条空行上（第一次按 ↓ 停在空行、第二次才进下一段，"一次一段"的手感
 * 断成两拍）。块与块之间的空行在排版里本来只是段落间距，视觉上不该停一拍。
 *
 * 返回 null = 不接管（调用方把按键交回默认行为）。
 */
export function verticalBlockTarget(
  covers: readonly BlockCover[],
  pos: number,
  defaultTarget: number,
  dir: -1 | 1,
): number | null {
  if (covers.length === 0) return null;
  const idx = covers.findIndex((c) => pos >= c.coverFrom && pos < c.coverTo);
  if (idx < 0) return null;
  const cur = covers[idx];
  // 默认结果仍落在**本块正文**内 → 块内移动，交回默认（多行块逐行走）
  if (defaultTarget >= cur.block.from && defaultTarget < cur.block.to) return null;
  const next = dir > 0 ? idx + 1 : idx - 1;
  if (next < 0 || next >= covers.length) return null;
  return dir > 0
    ? covers[next].block.from // 下一段正文的开头（跳过块前那条空行）
    : Math.max(0, covers[next].coverTo - 1); // 上一段的最后一个字符
}

/**
 * **编译出错时保留"没被改到"的切片**（纯函数，阶段 2）。
 *
 * 背景：块切片与块表是**同一次编译的产物**，一编译失败就没有新表 —— 原先的做法是整表作废
 * （`writingBlocks = null`），于是写作模式里敲错一个字符，**整篇文档**瞬间从真排版退回源码，
 * 改好才回来（闪烁且没法读数；用户报的"警告/错误看不见"也和这条有关：退回源码虽然能看到
 * 波浪线，但代价是整篇都退回）。
 *
 * 现在改成：用**前后缀差分**（不回退到逐字符 diff，够用且便宜）算出"改了哪一段"，
 *  - 完全在改动段**之前**的块：区间不变、切片照用；
 *  - 完全在改动段**之后**的块：区间整体平移 `delta`、切片照用（源码文本没变 ⇒ 排版结果照旧）；
 *  - 与改动段**相交**的块：标成不可渲染（`found:false` + 清空 svg）→ 它那一格退回源码，
 *    用户正在编辑的地方本来就是源码。
 *
 * 两条硬约束（错了会盖住正文，比不渲染严重得多）：
 *  1. **块表必须仍然铺满全文**（`planBlockCovers` 靠"每块一格、首尾相接"来切边界）：
 *     所以相交的块**保留在数组里**（只是不可渲染），不能凭空删掉；
 *  2. 相交块的区间取"自己 ∪ 改动段"的**并集（放宽）**：区间只会变大，它那一格顶多显示
 *     更多源码，绝不会把旁边还在渲染的切片盖到新打的字上面。
 *
 * 返回 `kept` = 仍然可以显示切片的块数（日志用）。
 */
export function remapBlocksThroughEdit(
  blocks: readonly Block[],
  before: string,
  after: string,
): { blocks: Block[]; kept: number } {
  if (blocks.length === 0) return { blocks: [], kept: 0 };
  if (before === after) return { blocks: [...blocks], kept: blocks.length };
  const span = changedSpan(before, after);
  const out: Block[] = [];
  let kept = 0;
  for (const b of blocks) {
    // 改动段之后：整体平移
    if (b.from >= span.to) {
      const shifted = { ...b, from: b.from + span.delta, to: b.to + span.delta };
      out.push(shifted);
      if (shifted.svg !== "" && shifted.found) kept++;
      continue;
    }
    // 改动段之前：原样保留
    if (b.to <= span.from) {
      out.push(b);
      if (b.svg !== "" && b.found) kept++;
      continue;
    }
    // 与改动段相交：退回源码（区间放宽到"自己 ∪ 改动段"，只多显示源码，不会盖住正文）
    const from = Math.min(b.from, span.from);
    out.push({
      ...b,
      from,
      to: Math.max(from, b.to + span.delta, span.to + span.delta),
      found: false,
      svg: "",
      heightPt: 0,
    });
  }
  return { blocks: out, kept };
}

/**
 * 两段文本的**改动区间**（纯函数）：共同前缀 + 共同后缀之外的那一段。
 *
 * 返回的 `from` / `to` 是**改动前**的坐标（`[from, to)` 这段被换掉了），
 * `delta` = 新长度 − 旧长度（旧文本里 `>= to` 的位置，在新文本里都要 +delta）。
 * 代价 O(n)，不做逐字符 diff —— 我们只需要"哪些块完全没被碰过"，粗糙一点反而更保守。
 */
export function changedSpan(before: string, after: string): { from: number; to: number; delta: number } {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before[p] === after[p]) p++;
  // 代理对不能被切开（emoji 的一半会让位置落在字符中间）
  if (p > 0 && isLowSurrogate(after[p]) && isHighSurrogate(after[p - 1])) p--;
  let s = 0;
  while (
    s < max - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) {
    s++;
  }
  if (s > 0 && isLowSurrogate(before[before.length - s])) s--;
  return { from: p, to: before.length - s, delta: after.length - before.length };
}

function isHighSurrogate(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * **有诊断（编译错误）的块不许被切片盖住**（纯函数，阶段 2）。
 *
 * 波浪线是画在**源码**上的装饰，而被切片盖住的块在 DOM 里只剩一张图片 ——
 * 错误落在那种块里时，用户看到的是"状态栏说有几处错误，但正文里哪儿也找不到"。
 * 这里把与诊断区间相交的格子标成"展开源码"，于是错误位置一定看得见（代价是那一块退回源码，
 * 而那正是需要改的地方）。
 */
export function revealBlocksWithDiagnostics(
  covers: BlockCover[],
  ranges: readonly { from: number; to: number }[],
): number {
  if (ranges.length === 0) return 0;
  let revealed = 0;
  for (const cover of covers) {
    if (cover.revealed || !cover.renderable) continue;
    // 判据用**格子**区间而不是块自身区间：格子还包含块前后的空行，而诊断落在空行上时
    // 同样会被切片盖住（半开区间：正好落在格子边界上的诊断归后一格，与选区的判法一致）
    const hit = ranges.some((r) => r.from < cover.coverTo && r.to > cover.coverFrom);
    if (!hit) continue;
    cover.revealed = true;
    revealed++;
  }
  return revealed;
}

/**
 * 块表是否仍然对应当前文档（供调试与"落后多少"的日志使用）。
 *
 * **注意**：块表过期时我们仍然沿用旧表（不做位置映射）。理由：编辑只发生在已展开的那一格
 * 里，其它格的覆盖区间首尾都落在空白处（块的源码终点 / 上一块的源码终点），偏一两个字符
 * 既不会露出来也不会吃掉正文；而"过期就整篇退回源码"会让每敲一个字都闪一次源码。
 * 编译结果回来后（数十毫秒）整表替换。
 */
export function isBlockTableFresh(table: BlockTable | null, doc: string): boolean {
  return table !== null && table.doc === doc;
}
