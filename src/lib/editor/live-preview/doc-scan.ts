// **文档扫描缓存**（报告 T3 / P1）：词法、公式、markup 与段落行识别按 CM Text 身份缓存。
//
// 为什么需要：`live-preview` 的装饰字段在 **docChanged / 选区变化 / 刷新 effect** 三种事务上
// 都会重建，而每次重建都要 `scanNonMarkupRegions`（词法区）+ `scanMathRanges`（公式区）+
// `buildMathContext`（前缀 + 文档内 `#let`）；请求收集器（`requests.ts`）在**视口变化**（滚动）
// 时还要再来一遍。选区移动、滚动这些**文档没变**的事务占日常操作的绝大多数 —— 每次全文重扫
// 就是纯浪费（40k 文档实测 6.4ms/次，滚动时每帧一次）。
//
// 判据用 **CodeMirror 的 `Text` 对象身份**而不是字符串：`Text` 是不可变、结构共享的，
// "同一个对象"就等于"文档一个字符都没变"（比较字符串是 O(n)，等于没省）。prefix 也参与键
// （它是编译上下文的一半，变了 `#let` 的解析结果与公式缓存键都会变）。
//
// **别把缓存做成"跨文档共享"**：`doc` 不同一律重算。这里只留**最近一份**（单条记忆化）——
// 同一时刻只有一个编辑器、一份文档在动，多加 LRU 只是给内存找事。
import type { EditorState } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import { scanNonMarkupRegions } from "../../core/typst-lex";
import type { Region } from "../../core/typst-lex";
import { scanMathRanges } from "../../core/math-ranges";
import type { MathRange } from "../../core/math-ranges";
import { buildMathContext } from "../../core/math-context";
import { scanMarkupDecorations } from "../../core/markup-ranges";
import type { MarkupDecoration } from "../../core/markup-ranges";
import { scanParagraphGapRows } from "../../core/paragraph-breaks";
import type { ParagraphGapRow } from "../../core/paragraph-breaks";

export interface DocScan {
  /** 这份扫描对应的 CM 文档对象（身份判据，见文件头） */
  doc: Text;
  /** 文档原文（`Text.toString()` 只在这里做一次） */
  docString: string;
  /** 参与本次扫描的编译前缀 */
  prefix: string;
  /** 编译上下文（前缀 + 文档内 `#let`）：`mathCacheKey` 的一半 */
  context: string;
  /** 非 markup 区域（code / raw / comment / string） */
  opaque: Region[];
  /** 公式区间 */
  math: MathRange[];
  /** 常用 markup 装饰范围（文档不变时复用，选区移动不重扫全文） */
  markup: MarkupDecoration[];
  /** 默认段距对应的空白源码行（与 markup 一样按 Text 身份缓存） */
  paragraphGapRows: ParagraphGapRow[];
}

let cache: DocScan | null = null;
let hits = 0;
let misses = 0;

/**
 * 取当前 state 的扫描结果（命中缓存就原样返回，**不要再改它**：调用方只读）。
 * `prefix` 变了会重算（见文件头）。
 */
export function scanDocument(state: EditorState, prefix: string): DocScan {
  const doc = state.doc;
  if (cache && cache.doc === doc && cache.prefix === prefix) {
    hits += 1;
    return cache;
  }
  misses += 1;
  const docString = doc.toString();
  const opaque = scanNonMarkupRegions(docString);
  const math = scanMathRanges(docString, opaque);
  const markup = scanMarkupDecorations(docString, { opaque, math });
  cache = {
    doc,
    docString,
    prefix,
    context: buildMathContext(prefix, docString),
    opaque,
    math,
    markup,
    paragraphGapRows: scanParagraphGapRows(docString, opaque, math, markup, prefix),
  };
  return cache;
}

/** 诊断 / 验收：命中与未命中次数（"纯选区移动不重新扫描全文"就靠它断言） */
export function docScanStats(): { hits: number; misses: number; cached: boolean } {
  return { hits, misses, cached: cache !== null };
}

/** 测试用：清掉缓存与计数（文档切换**不需要**清 —— `doc` 身份不同自然重算） */
export function resetDocScanCache(): void {
  cache = null;
  hits = 0;
  misses = 0;
}
