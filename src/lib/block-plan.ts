// 写作模式的块级渲染：**规划**（纯函数，可单测）。
//
// 形态（见 docs/文档模式渲染保真-调研.md 第三节）：整篇编译一次 → 每个源块在版面上的那一块
// 被切成一张 SVG → 编辑器里"非光标所在块"用 widget 显示这张切片，"光标所在块"保持源码。
//
// 本模块只做决策，不碰 CodeMirror：把"块表 + 当前选区 + 文档长度"算成
// "哪些区间要被 widget 覆盖"，落成装饰由 live-preview.ts 负责。
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
  raw: Pick<BlockCrop, "start" | "end" | "kind" | "found" | "svg" | "widthPt" | "heightPt" | "pages">[],
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
 * 为什么格子要吃掉块前面的空白：块与块之间的空行在编辑器里本来占一行高（写作模式行距 1.9），
 * 而排版里的段落间距已经算进切片高度（相邻块各分到一半间距）——若只替换块自身，这些空行会
 * 额外叠出空白，摞起来就不等于原版式。把空白交给**下面那一块**的 widget，切片按序摞起来
 * 才是"和真实 typst 一样"。
 *
 * 不可渲染的块（`#let` / `#show` / 注释行）保持可见、永不被 widget 覆盖：它们的格子不并入
 * 邻居（格子边界仍然按"上一块终点"切），所以源码透镜上看到的永远是"代码碎片留在原处"。
 */
export function planBlockCovers(
  blocks: readonly Block[] | null,
  docLength: number,
): BlockCover[] {
  if (!blocks || blocks.length === 0) return [];
  const covers: BlockCover[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const coverFrom = i > 0 ? blocks[i - 1].to : 0;
    const coverTo = i + 1 < blocks.length ? block.to : Math.max(docLength, block.to);
    covers.push({
      block,
      coverFrom: Math.min(coverFrom, block.from),
      coverTo: Math.max(coverTo, block.to),
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
): boolean {
  let changed = false;
  for (const cover of covers) {
    const hit =
      !cover.renderable ||
      selections.some((s) => s.from <= cover.coverTo && s.to >= cover.coverFrom);
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
