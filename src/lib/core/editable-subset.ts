// **可编辑子集的纯决策**（任务 1）：一个块到底该"直接编辑真实文本"还是"退回切片/源码"。
//
// 源码始终是唯一文档状态；只有**同时**满足四个条件的块才获得原位编辑资格：
//   ① `syntax`   —— 源码结构在**白名单**内（段落/标题、单源码行、不含 code/raw/comment）；
//   ② `text`     —— **呈现文字已被证明能唯一对应回这段源码**（后端 `BlockCrop.edit`，见
//                   `text_proof.rs`）；`found`、SVG 存在、字形有 `Span` 都**不能**单独证明它；
//   ③ `geometry` —— 这一块有可用几何（引擎确实画了它，且没有被有意跳过）；
//   ④ `fresh`    —— 这份产物说的就是**当前文档**这段文字（用证明里带的源码逐字比对）。
//
// 资格属于**当前编译结果**，不是 AST 类型的永久属性：同一个 `Paragraph` 块，只要 show rule
// 换了字、宏在使用处展开、或产物已经过期，就不再可编辑。
//
// 判定只在这里做一次：块级装饰（`live-preview/block-decorations`）只消费本模块的结论，
// 不再自己写一套语法判据；后端只提供"帧里画了什么"的证明，不重写语法白名单。
import type { Block, BlockEditProof } from "./block-plan";
import { scanAllowedInlineCode } from "./markup-ranges";
import { scanNonMarkupRegions } from "./typst-lex";
import type { Region } from "./typst-lex";

/** 源码结构在白名单内吗 */
export type EditSyntax = "simple" | "unsupported";
/**
 * 呈现文字与源码的对应关系：
 *  - `verified`：后端严格证明成立；
 *  - `unknown`：有证明通道但**证不出来**（换了字 / 宏展开 / 重复输出 / 外来墨迹…）→ 切片；
 *  - `no-proof`：产物里**没有**这个字段（旧后端 / 只提供几何的桩）→ 退回旧的语法判据。
 */
export type EditText = "verified" | "unknown" | "no-proof";
/** 几何是否适用于该编辑形式 */
export type EditGeometry = "ok" | "missing";

/** 四个独立信号（可单独断言，别只看最终布尔） */
export interface EditSignals {
  syntax: EditSyntax;
  text: EditText;
  geometry: EditGeometry;
  fresh: boolean;
}

/** 拒绝/通过的原因码（机器可读，便于测试与排障） */
export type EditReason =
  | "editable"
  | "no-output"
  | "not-text-kind"
  | "list-unsupported"
  | "multi-line"
  | "complex"
  | "skipped"
  | "no-geometry"
  | "text-unknown"
  | "text-stale";

export interface EditDecision extends EditSignals {
  editable: boolean;
  reason: EditReason;
}

/** 决策的输入：块（含后端证明）+ 它当前的源码 + 复杂区域表 */
export interface EditDecisionInput {
  block: Pick<Block, "from" | "to" | "kind" | "found" | "skipped" | "noOutput" | "heightPt"> & {
    edit?: BlockEditProof | null;
    listMarker?: { text: string; bodyOffsetPt: number } | null;
  };
  /** `doc.slice(block.from, block.to)` —— 当前文档里这一块的源码 */
  source: string;
  /** 复杂区域（code/raw/comment），由 `scanNonMarkupRegions` 给出 */
  opaque: readonly Region[];
  /**
   * **白名单行内调用**的代码区间（`#strong` / `#emph`，见 `scanAllowedInlineCode`）：
   * 这些 code 区域不算"复杂"，块仍可直接编辑（正文照常逐字对应）。
   */
  allowedCode?: readonly { from: number; to: number }[];
}

/**
 * 块区间与"复杂区域"（code / raw / comment）相交吗。
 *
 * `opaque` 按位置有序且互不重叠 ⇒ 二分找到第一个 `from >= from` 的区域，再往后扫到越过块尾
 * 为止。**别写成从头线性扫**：这是每个格子一次、每次按键重建装饰一次，即 O(块 × 区域)；
 * `markup-ranges` 里记过同样的教训（40k 字符实测 47ms/次）。
 *
 * **`string` 不算复杂**：lexer 把 markup 里任何 `"` 都登记成 string（为了让 `"$5"` 不被当成
 * 公式），而 markup 里的 `"` 是 typst 的引号、是纯 markup —— 算进去会让写了一对引号的正文
 * 整段退回切片。真在代码里的字符串一定被外层的 `code` 区域包住。
 */
export function overlapsComplexRegion(
  from: number,
  to: number,
  opaque: readonly Region[],
): boolean {
  let lo = 0;
  let hi = opaque.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (opaque[mid].from < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 1); i < opaque.length; i++) {
    const region = opaque[i];
    if (region.from >= to) break;
    if (region.kind === "string") continue;
    if (region.to > from && region.from < to) return true;
  }
  return false;
}

/**
 * 与 `overlapsComplexRegion` 同一条扫描，但**白名单行内调用**（`#strong` / `#emph`）的区域放行。
 *
 * 放行的判据是"这个 code 区域**整体落在**某个允许区间里"（半开区间包含），不是"有交叠就放行" ——
 * 否则 `#strong[#h(1em)]` 这种夹带别的代码的写法会被整段放过。
 */
export function overlapsComplexExcept(
  from: number,
  to: number,
  opaque: readonly Region[],
  allowed: readonly { from: number; to: number }[],
): boolean {
  const isAllowed = (r: Region) => allowed.some((a) => a.from <= r.from && a.to >= r.to);
  let lo = 0;
  let hi = opaque.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (opaque[mid].from < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 1); i < opaque.length; i++) {
    const region = opaque[i];
    if (region.from >= to) break;
    if (region.kind === "string") continue;
    if (region.to > from && region.from < to && !isAllowed(region)) return true;
  }
  return false;
}

/**
 * **一个文字块能不能直接编辑**（纯函数）。
 *
 * 顺序即原因码优先级：先排除"根本不是这一类块"，再看结构、几何，最后看证明与新鲜度。
 * 之所以把 `text` 放在最后，是因为它最贵（要后端产物），而前面的条件在旧后端/桩上也能成立。
 */
export function decideTextBlockEditing(input: EditDecisionInput): EditDecision {
  const { block, source, opaque, allowedCode } = input;
  const textKind = block.kind === "Paragraph" || block.kind === "Heading";
  const listKind = block.kind === "ListItem" || block.kind === "EnumItem";
  /**
   * 简单列表项的判据（任务 2）：
   *  - **单源码行、顶格**（`^[-+][ \t]+` 且没有前导空白）：嵌套项在 typst 语法树里与外层
   *    同块（含换行），多段/块级子内容也必然多行，这里一并挡掉；
   *  - **引擎给了标记**（`listMarker`）：符号/缩进/编号必须来自 typst，前端不拿近似冒充；
   *  - 内容非空（`\S`）。
   */
  const listSimple =
    listKind &&
    block.listMarker != null &&
    /^[-+][ \t]+\S/.test(source) &&
    !source.includes("\n") &&
    // **含行内公式的列表项不开放**（实测 PKU 高代周二 L101/L185）：列表的正文列更窄，
    // 而 Typst 会在行内公式内部折行、浏览器把公式当原子 widget —— 引擎断点落在公式里时
    // 前端整块不折（见 buildEngineBreakDecorations），于是折行数与 Typst 对不上。
    // 宁可整项切片（切片就是 Typst 的真排版），也不在"文字像文字"时就放行。
    !source.includes("$");
  const multiLine = source.includes("\n");
  const complex = overlapsComplexExcept(block.from, block.to, opaque, allowedCode ?? []);
  const syntax: EditSyntax =
    (textKind || listSimple) && !multiLine && !complex ? "simple" : "unsupported";
  const geometry: EditGeometry =
    block.found && !block.skipped && block.heightPt > 0.5 ? "ok" : "missing";

  const proof = block.edit ?? null;
  const text: EditText =
    proof === null ? "no-proof" : proof.verdict === "verified" ? "verified" : "unknown";
  // `no-proof`（旧后端 / 桩）没有可比对的源码：保持旧行为，不因为缺字段就退回切片
  const fresh = proof === null ? true : proof.source === source;

  const signals: EditSignals = { syntax, text, geometry, fresh };
  const base = (reason: EditReason): EditDecision => ({ ...signals, editable: false, reason });
  if (block.noOutput === true) return base("no-output");
  if (!textKind && !listKind) return base("not-text-kind");
  if (listKind && !listSimple) return base("list-unsupported");
  if (multiLine) return base("multi-line");
  if (complex) return base("complex");
  if (block.skipped) return base("skipped");
  if (geometry === "missing") return base("no-geometry");
  if (!fresh) return base("text-stale");
  if (text === "unknown") return base("text-unknown");
  return { ...signals, editable: true, reason: "editable" };
}

/** 便捷入口：直接按文档文本与块算决策（区域表与白名单都现算） */
export function decideTextBlockEditingIn(
  doc: string,
  block: EditDecisionInput["block"],
): EditDecision {
  const opaque = scanNonMarkupRegions(doc);
  return decideTextBlockEditing({
    block,
    source: doc.slice(block.from, block.to),
    opaque,
    allowedCode: scanAllowedInlineCode(doc, opaque),
  });
}
