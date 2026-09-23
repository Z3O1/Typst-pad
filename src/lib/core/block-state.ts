// 块表这份**派生状态**的落地（从 +page.svelte 搬出来）：编译结果回来时怎么换块表、编辑期间怎么
// 让块表跟上、以及"视口内要渲哪一段"的窗口换算。纯逻辑（无响应式、无 IPC），有单测。
//
// 来源：PR #63（"页面剩余四块逻辑抽成模块"第二轮）里与主干**不重复**的那两块之一。主干已经用
// `core/block-plan.ts` 的 `remapBlocksThroughEdit` / `carryOverCrops` / `toBlockTable` 提供了
// 纯函数，这里收进来的只是页面围着它们的那圈编排（读旧快照 → 算 → 回写、日志、exact/几何闸门），
// 行为零改动。
//
// 三条红线（展开见 docs/development/writing-rendering.md）：
//
// 1. **编译失败时宁可保留切片、也不要整篇退回源码**：只把被改动到的那一块退回源码（用前后缀差分
//    平移其余块）。否则敲错一个字符就看到整篇源码闪一下，改好才回来。
//    但 `exact` 必须同时置 false —— 平移来的区间是**估算**的，而 Rust 侧的几何/命中缓存还是失败
//    前那一版，混着用会点错地方（`writingBlocksExact` 那道闸门就是为它设的）。
// 2. **块表必须与文档严格对应**（`doc` 跟块表一起存）：块区间是字节偏移，只有配上同一份文档才有
//    意义；文档换了一次编译就要整批作废（`resetBlocks` 在页面，理由见那边的注释）。
// 3. **编辑期间也要平移**（`remapBlocksOnEdit`）：插入换行会改变行结构，而格子边界是按"块的最后一
//    行之后"算的 —— 旧坐标放在新文档上会算到错误的行，表现为"刚打的那行落进旁边的旧切片里"。
// 4. **产物必须带"排版戳"**（报告 T2 / A4）：`RenderStamp` 记下这份产物是在哪一份文档、哪一套
//    编译上下文与版心下渲出来的。沿用缓存只在"戳上的排版输入没变"时才允许开（`carryOverCrops`
//    的 `allow`）；沿用的块一律标 `stale`（精确命中关掉、滚到附近要补渲）。

import { positionRangeToByteRange } from "./block-offsets";
import { carryOverCrops, remapBlocksThroughEdit, toBlockTable } from "./block-plan";
import type { Block } from "./block-plan";
import type { BlocksFail, BlocksOk } from "./typst-engine";

/**
 * **排版戳**：一份块级产物的"出身"（报告 T2）。
 *
 * 为什么不能只比文档字符串：同一份文本在不同版心宽度、不同字体设置、不同编译前缀下
 * **排版不同**（引用编号、折行、字号都可能变），所以"文本相同"既不等于"图上就是它"，
 * 也不等于"旧图能配新几何"。四个修订号分工：
 *  - `sessionId`：打开 / 新建 / 重读文件后 +1 —— 上一份文档的产物一律作废；
 *  - `documentRevision`：每次编辑 +1（编辑期间块表已经用 `remapBlocksOnEdit` 跟上了，
 *    但那些区间是**平移来的估算**，不能当"精确"用）；
 *  - `contextRevision`：编译前缀 / 字体设置 / 目标文件路径变化时 +1（影响排版与编号）；
 *  - `layoutRevision`：版心宽度变化时 +1（写作模式重排）。
 */
export interface RenderStamp {
  sessionId: number;
  documentRevision: number;
  contextRevision: number;
  layoutRevision: number;
}

/** 两个戳是否**完全**相同（缺省视为同一份全零戳，便于老调用方） */
export function sameStamp(
  a: RenderStamp | null | undefined,
  b: RenderStamp | null | undefined,
): boolean {
  const x = a ?? ZERO_STAMP;
  const y = b ?? ZERO_STAMP;
  return (
    x.sessionId === y.sessionId &&
    x.documentRevision === y.documentRevision &&
    x.contextRevision === y.contextRevision &&
    x.layoutRevision === y.layoutRevision
  );
}

/** 全零戳：没有产物时的占位（`sameStamp(undefined, undefined) === true`） */
export const ZERO_STAMP: RenderStamp = Object.freeze({
  sessionId: 0,
  documentRevision: 0,
  contextRevision: 0,
  layoutRevision: 0,
});

/**
 * 补渲去重键（`handleBlocksNeeded` 用）：**必须带上完整的戳**。
 * 只用 `from:to` 时，同一个窗口在新一次编辑之后会被判成"已经渲过"而永远不再补渲
 * （旧图/源码一直留在那儿）；带上戳之后"同一窗口的新 revision"是一次**新**请求。
 */
export function stampKey(stamp: RenderStamp, window: { from: number; to: number } | null): string {
  const w = window === null ? "all" : `${window.from}:${window.to}`;
  return `${stamp.sessionId}/${stamp.documentRevision}/${stamp.contextRevision}/${stamp.layoutRevision}|${w}`;
}

/** 块级渲染窗口的前后预取（**字符**数，见 blockWindowBytes） */
export const BLOCK_WINDOW_MARGIN = 4000;

/** 块表这份派生状态的快照（上一次落地之后的四个值） */
export interface BlocksSnapshot {
  /** 当前块表（null = 没有切片，编辑器整篇显示源码） */
  blocks: Block[] | null;
  /**
   * 这份产物的排版戳（见 RenderStamp）。**可缺省**：缺省按全零戳处理（`sameStamp` 兜底），
   * 这样"还没有产物"的空快照与单测里手搓的快照都不必显式给。
   */
  stamp?: RenderStamp;
  /** 块表对应的**文档原文**（= 生成这批切片时编译的那一份） */
  doc: string;
  /** 生成块表的那次编译在 Rust 侧写下的几何编号（0 = 没有几何） */
  geometryId: number;
  /** 文档正文实际字号（pt，源码透镜的字号基准） */
  textPt: number;
}

/** 一次落地要写回页面的东西 */
export interface BlocksPatch {
  blocks: Block[] | null;
  doc: string;
  /** 与 `blocks` 成套的排版戳（沿用来的块已按 `stale` 标好） */
  stamp: RenderStamp;
  /** 区间是否**精确**（false = 估算的 → 点击不做精确定位，退回"光标落到块首"） */
  exact: boolean;
  /** 这一批切片对应的 Rust 侧几何编号（失败分支**保持旧值**：块表还是上一批的那些切片） */
  geometryId: number;
  /** 正文实际字号（这次没量到 / 与旧值几乎相同 → 保持原值） */
  textPt: number;
  /** 调试日志正文（"blocks ok …" / "blocks fail …"；耗时由页面接在后面） */
  log: string;
  /** 窗口化渲染的统计日志（没有"沿用/待渲"时是 null） */
  detail: string | null;
}

/**
 * 编译结果 → 新块表。
 *
 * 成功：字节偏移换算成编辑器位置（只在这里做一次）→ 窗口外没拿到 SVG 的块按"块类型 + 源码文本
 * 相同"沿用上一轮结果 → 这批切片与这份文档、这份几何严格对应（`exact` 打开）。
 * 失败：**不整篇作废**，用前后缀差分把没被碰到的块原样平移（`exact` 关掉，见文件头第 1 条）。
 */
export function landBlocksResult(
  prev: BlocksSnapshot,
  doc: string,
  result: BlocksOk | BlocksFail,
  stamp: RenderStamp = ZERO_STAMP,
): BlocksPatch {
  if (result.ok) {
    const table = toBlockTable(doc, result.blocks);
    // 窗口化渲染：窗口外的块这轮没有 SVG，按"块类型 + 源码文本相同"沿用上一轮结果。
    // **但只在排版输入没变时才允许沿用**（报告 T2 / A4）：版心宽度、字体、前缀一变，
    // "文本相同"就不再等于"排版相同"（引用编号、折行、字号都可能变），旧图配新几何比缺图更坏。
    const allowCarry = sameStamp(prev.stamp, {
      ...stamp,
      documentRevision: (prev.stamp ?? ZERO_STAMP).documentRevision,
    });
    const carried = carryOverCrops(prev.blocks, table.blocks, doc, { allow: allowCarry });
    return {
      blocks: carried.blocks,
      doc,
      stamp,
      exact: true,
      geometryId: result.geometryId,
      // 后端没给（旧版本/桩）时是 0 → 保持上一次量到的字号，别把透镜字号打回默认值
      textPt: textPtPatch(prev.textPt, result.textPt),
      log: `blocks ok blocks:${result.blocks.length} 页宽:${result.pageWidthPt.toFixed(1)}pt`,
      detail:
        carried.carried > 0 || carried.missing > 0
          ? `切片窗口：新渲 ${result.blocks.filter((b) => b.svg).length} / 沿用 ${carried.carried} / 待渲 ${carried.missing}`
          : null,
    };
  }
  // 失败：旧表是上一次成功编译的产物（区间 + 切片成套），只把"被改动到的那一块"退回源码
  const remap = prev.blocks
    ? remapBlocksThroughEdit(prev.blocks, prev.doc, doc)
    : { blocks: [] as Block[], kept: 0 };
  return {
    // 平移来的块同样是"旧图 + 新文档坐标"：标 stale（精确命中关掉、滚到附近要补渲）
    blocks: remap.blocks.length > 0 ? remap.blocks.map((b) => ({ ...b, stale: true })) : null,
    doc,
    stamp,
    exact: false, // 区间是估算的：点击精确定位据此退出
    geometryId: prev.geometryId, // 块表没换，几何编号也就不动
    textPt: prev.textPt,
    log: `blocks fail errors:${result.errors.length} 保留切片:${remap.kept}/${remap.blocks.length}`,
    detail: null,
  };
}

/**
 * **每次编辑都让块表跟上**（见文件头第 3 条）。
 * 返回 null = 没有块表、或文档没变（什么都不用做）；返回 patch = 页面写回这四个值并自增代次
 * （让编辑器按新表重建装饰，不然这一帧渲染出来的还是旧表的格子）。
 */
export function remapBlocksOnEdit(
  prev: BlocksSnapshot,
  newDoc: string,
  documentRevision: number,
): BlocksPatch | null {
  if (!prev.blocks || prev.blocks.length === 0) return null;
  if (prev.doc === newDoc) return null;
  const remap = remapBlocksThroughEdit(prev.blocks, prev.doc, newDoc);
  return {
    // 编辑后的块表是**估算**的：图还是旧图的，标 stale 让精确命中与补渲都走保守路线
    blocks: remap.blocks.map((b) => ({ ...b, stale: true })),
    doc: newDoc,
    stamp: { ...(prev.stamp ?? ZERO_STAMP), documentRevision },
    // 平移**不**等于"精确"：几何与命中缓存都还是上一次编译的
    exact: false,
    geometryId: prev.geometryId,
    textPt: prev.textPt,
    log: "",
    detail: null,
  };
}

/**
 * 块级渲染窗口（**文档坐标的字节偏移**）：视口范围 → 字节 + 前后各留一段预取。
 * 取不到视口（编辑器未挂载）或文档很短（≤ 2×预取）时返回 null = 整篇都渲。
 *
 * 编辑器没挂载时从文档开头起一段，而不是整篇渲：光标在启动时本来就在开头，而"取不到视口就整篇渲"
 * 在长文档下会一次性渲出十几 MB（实测 58 字节/字符）。
 */
export function blockWindowBytes(
  doc: string,
  visible: { from: number; to: number } | null,
): { from: number; to: number } | null {
  if (doc.length <= BLOCK_WINDOW_MARGIN * 2) return null; // 短文档：全渲，省一次换算
  const from = Math.max(0, (visible?.from ?? 0) - BLOCK_WINDOW_MARGIN);
  const to = Math.min(doc.length, (visible?.to ?? 0) + BLOCK_WINDOW_MARGIN);
  return positionRangeToByteRange(doc, from, to);
}

/**
 * 字号补丁：只有"量到了、且与旧值确有差别"才更新（0.01pt 以内视为噪声，别让 0.002 的抖动
 * 每次都触发编辑器重排）。
 */
function textPtPatch(prev: number, next: number): number {
  return next > 0 && Math.abs(next - prev) > 0.01 ? next : prev;
}
