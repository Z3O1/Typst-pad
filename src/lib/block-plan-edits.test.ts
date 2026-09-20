// **各种输入**下的块级渲染不变量（纯逻辑，不依赖 DOM / 夹具，CI 里也跑）。
//
// 起因：用户报「在一块内 Enter 插入块的时候会有问题」——那次的根因是"块表是上一次编译的旧坐标，
// 而插入换行改变了行结构"（见 docs/文档模式渲染保真-调研.md 第十一节）。修完之后把**所有常见
// 编辑动作**都拿同一套不变量过一遍，别只剩 Enter 一条被锁住。
//
// 每个动作都在"文档的每个位置"上做一遍（短文档，位置逐个来），然后检查四条：
//   ① **不抛异常**：哪怕用**旧表**（编辑那一瞬间装饰层看到的就是旧表）也不能抛
//      （实测踩过：旧坐标越界 → `doc.lineAt(116)` 抛 RangeError → 整篇退化成源码）；
//   ② **改动看得见**：被改动的那段必须落在**已展开**的格子里（用户刚打的字不能被旧切片盖住）；
//   ③ **格子边界落在行首**：CodeMirror 的块级替换硬要求（错一个字符会"既插 widget 又留原文"）；
//   ④ **不重复、不吞字**：未展开的格子必须把那一块的正文**完整**盖住（半盖 = 同一段文字
//      既在旧切片里、又露出一截源码），且格子首尾相接铺满全文。
import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import {
  applyBlockSelection,
  changedSpan,
  planBlockCovers,
  remapBlocksThroughEdit,
  toBlockTable,
} from "./block-plan";
import type { Block, BlockCover } from "./block-plan";
import type { BlockCrop } from "./typst-engine";

/** 真实形状的样例文档：标题 / 段落 / 列表（项间没有空行）/ 跨行公式 / 块前双空行 */
const DOCS: { name: string; doc: string; pieces: string[] }[] = [
  {
    name: "标题 + 两段",
    doc: "= 标题\n\n第一段。\n\n第二段。\n",
    pieces: ["= 标题", "第一段。", "第二段。"],
  },
  {
    name: "列表（每项一块）",
    doc: "- 甲\n- 乙\n- 丙\n\n尾段。\n",
    pieces: ["- 甲", "- 乙", "- 丙", "尾段。"],
  },
  {
    name: "跨行的行间公式",
    doc: "前文。\n\n$ a + b \\\n  + c $\n\n后文。\n",
    pieces: ["前文。", "$ a + b \\\n  + c $", "后文。"],
  },
  {
    name: "块前有两个空行 + 末块带缩进",
    doc: "= 标题\n\n\n正文。\n\n  缩进的段落。\n",
    pieces: ["= 标题", "正文。", "  缩进的段落。"],
  },
];

/** 按顺序在文档里定位每个块的**字节**区间（测试自己算，不手写偏移） */
function byteRanges(doc: string, pieces: string[]): [number, number][] {
  const enc = new TextEncoder();
  let cursor = 0;
  return pieces.map((p) => {
    const at = doc.indexOf(p, cursor);
    expect(at, `文档里应找得到块 ${JSON.stringify(p)}`).toBeGreaterThanOrEqual(0);
    const start = enc.encode(doc.slice(0, at)).length;
    cursor = at + p.length;
    return [start, start + enc.encode(p).length] as [number, number];
  });
}

function blocksOf(doc: string, pieces: string[]): Block[] {
  const raw: BlockCrop[] = byteRanges(doc, pieces).map(([start, end]) => ({
    start,
    end,
    kind: "Paragraph",
    found: true,
    pages: 1,
    page: 1,
    xPt: 58,
    yPt: 40,
    widthPt: 371,
    heightPt: 20,
    bands: 1,
    svg: "<svg/>",
  }));
  return toBlockTable(doc, raw).blocks;
}

/** 一次编辑动作：给定文档与光标位置，算出新文档与新的光标位置（null = 这个位置不适用） */
interface EditOp {
  name: string;
  run: (
    doc: string,
    at: number,
  ) => { next: string; caret: number; changed: [number, number] } | null;
}

const lineStartOf = (doc: string, at: number) => doc.lastIndexOf("\n", Math.max(0, at - 1)) + 1;

const OPS: EditOp[] = [
  // ---- 插入类 ----
  { name: "打字（单字符）", run: (d, at) => ins(d, at, "字") },
  { name: "打字（多字符）", run: (d, at) => ins(d, at, "三个字") },
  { name: "回车（拆行）", run: (d, at) => ins(d, at, "\n") },
  { name: "回车两次（新块）", run: (d, at) => ins(d, at, "\n\n") },
  { name: "回车三次", run: (d, at) => ins(d, at, "\n\n\n") },
  { name: "输入 `$` （行间公式脚手架）", run: (d, at) => ins(d, at, "$  $") },
  { name: "输入围栏代码块", run: (d, at) => ins(d, at, "```\ncode\n```") },
  { name: "粘贴多段文本", run: (d, at) => ins(d, at, "新段一。\n\n新段二。\n\n") },
  { name: "Tab 缩进（行首插 4 空格）", run: (d, at) => ins(d, lineStartOf(d, at), "    ") },
  // ---- 删除类 ----
  { name: "退格删一个字符", run: (d, at) => del(d, at - 1, at) },
  { name: "Delete 删一个字符", run: (d, at) => del(d, at, at + 1) },
  { name: "退格删到与上一行合并", run: (d, at) => del(d, at - 1, at) },
  {
    name: "删掉一整行",
    run: (d, at) =>
      del(
        d,
        lineStartOf(d, at),
        lineStartOf(d, at) + (d.slice(lineStartOf(d, at)).split("\n")[0]?.length ?? 0) + 1,
      ),
  },
  {
    name: "选中一段替换",
    run: (d, at) => {
      const from = Math.max(0, at - 3);
      const cut = del(d, from, at);
      if (!cut) return null;
      return {
        next: cut.next.slice(0, from) + "替换" + cut.next.slice(from),
        caret: from + 2,
        changed: [from, from + 2],
      };
    },
  },
  { name: "全选替换成短文档", run: (d) => ({ next: "短。\n", caret: 2, changed: [0, d.length] }) },
  {
    name: "全选替换成长文档",
    run: (d) => ({
      next: Array.from({ length: 12 }, (_, i) => `第 ${i} 段正文。`).join("\n\n") + "\n",
      caret: 0,
      changed: [0, d.length],
    }),
  },
  {
    name: "撤销（回退到上一版文档）",
    run: (d, at) => ({
      next: d.slice(0, Math.max(0, d.length - 3)),
      caret: Math.max(0, d.length - 3),
      changed: [Math.max(0, d.length - 3), d.length],
    }),
  },
];

function ins(doc: string, at: number, text: string) {
  return {
    next: doc.slice(0, at) + text + doc.slice(at),
    caret: at + text.length,
    changed: [at, at + text.length] as [number, number],
  };
}

function del(doc: string, from: number, to: number) {
  if (from < 0 || to > doc.length || from >= to) return null;
  return {
    next: doc.slice(0, from) + doc.slice(to),
    caret: from,
    changed: [from, from] as [number, number],
  };
}

/**
 * 一次编辑之后必须成立的**四条不变量**。`stale` 是"没平移过的旧表"——装饰层在编辑发生的那一
 * 次更新里看到的就是它，所以它只要求"不抛异常"。
 */
function checkAfterEdit(
  doc: string,
  blocks: Block[],
  next: string,
  caret: number,
  what: string,
): void {
  // ① 旧表 + 新文档：**不能抛**（越界坐标必须被滤掉）
  expect(
    () => planBlockCovers(blocks, Text.of(next.split("\n"))),
    `${what}：旧表不许抛异常`,
  ).not.toThrow();

  // ② 增量平移后重建格子；**按页面侧同样的过滤**（越界 / 退化的格子会被丢掉，见 buildBlockCovers）
  const remap = remapBlocksThroughEdit(blocks, doc, next);
  const all = planBlockCovers(remap.blocks, Text.of(next.split("\n")));
  const covers = all.filter(
    (c) =>
      c.coverFrom >= 0 &&
      c.coverTo <= next.length &&
      c.coverTo > c.coverFrom &&
      c.block.from < next.length,
  );
  expect(covers.length, `${what}：至少还得有一格`).toBeGreaterThan(0);
  applyBlockSelection(covers, [{ from: caret, to: caret }], next.length);

  const span = changedSpan(doc, next);
  const newSpan = {
    from: span.from,
    to: Math.max(span.from, next.length - (doc.length - span.to)),
  };

  // ③ 改动必须落在**已展开**的格子里
  for (const c of covers as BlockCover[]) {
    if (!c.revealed && newSpan.from < c.coverTo && newSpan.to > c.coverFrom) {
      throw new Error(
        `${what}：改动落在未展开的格子里 [${c.coverFrom},${c.coverTo})（块 [${c.block.from},${c.block.to})）\n` +
          `  新文档=${JSON.stringify(next)}`,
      );
    }
  }

  // ④ 格子边界落在行首
  const lineStarts = new Set<number>();
  let off = 0;
  for (const line of next.split("\n")) {
    lineStarts.add(off);
    off += line.length + 1;
  }
  for (const c of covers as BlockCover[]) {
    if (!lineStarts.has(c.coverFrom)) throw new Error(`${what}：格子起点不在行首 ${c.coverFrom}`);
    if (c.coverTo !== next.length && !lineStarts.has(c.coverTo)) {
      throw new Error(`${what}：格子终点不在行首 ${c.coverTo}`);
    }
  }

  // ⑤ 不重复、不吞字：未展开的格子必须把那一块正文完整盖住；格子首尾相接铺满全文
  for (let i = 0; i < covers.length; i++) {
    const c = covers[i] as BlockCover;
    if (c.renderable && !c.revealed && !(c.block.from >= c.coverFrom && c.block.to <= c.coverTo)) {
      throw new Error(
        `${what}：块 [${c.block.from},${c.block.to}) 只被格子 [${c.coverFrom},${c.coverTo}) 盖住一部分`,
      );
    }
    if (i > 0 && (covers[i - 1] as BlockCover).coverTo !== c.coverFrom) {
      throw new Error(
        `${what}：格子之间不连续 ${(covers[i - 1] as BlockCover).coverTo} ≠ ${c.coverFrom}`,
      );
    }
  }
  expect((covers[0] as BlockCover).coverFrom, `${what}：首格应从 0 开始`).toBe(0);
  expect((covers[covers.length - 1] as BlockCover).coverTo, `${what}：末格应到文末`).toBe(
    next.length,
  );
}

describe("各种输入下的块级渲染不变量（每个位置逐个来）", () => {
  for (const d of DOCS) {
    for (const op of OPS) {
      it(`${d.name} × ${op.name}`, () => {
        const blocks = blocksOf(d.doc, d.pieces);
        let count = 0;
        for (let at = 0; at <= d.doc.length; at++) {
          const edit = op.run(d.doc, at);
          if (!edit) continue;
          checkAfterEdit(d.doc, blocks, edit.next, edit.caret, `pos=${at}`);
          count++;
        }
        expect(count, "至少覆盖到一个位置").toBeGreaterThan(0);
      });
    }
  }
});
