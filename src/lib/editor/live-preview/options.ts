// 扩展的**公共接口与常量**：options / 请求类型 / 刷新 effect。
//
// 单独成文件是为了让拆分出去的装饰模块能 import 它而不反向依赖组装层（避免循环依赖）。
// `live-preview.ts` 会把它们原样再导出，外部（Editor.svelte / +page.svelte）的 import 路径不变。
import { StateEffect } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import type { MathRender } from "../../core/typst-engine";
import type { Block } from "../../core/block-plan";

/** 待渲染的公式（父组件据此调用 Rust 侧 compile_math） */
export interface MathRequest {
  /** 缓存键（body + 风格 + 编译上下文） */
  key: string;
  body: string;
  display: boolean;
  /**
   * 生成该 key 时用的编译上下文（前缀 + 文档内定义）。
   * **必须随请求一起传**：父组件的渲染是异步批处理，若那时再取当前上下文，
   * 文档在这期间又变了，就会出现「用新上下文编出的结果存进旧 key」的错配
   * （表现为公式短暂显示旧宏的排版）。
   */
  context: string;
  /**
   * 生成该 key 时用的**公式字号**（pt）。同样必须随请求一起传 —— 理由与 `context` 一致：
   * 父组件是异步批处理，写作模式下的字号跟着文档走（`textPt` 会随编译结果变），
   * 那时再取当前字号就会「用新字号编出的结果存进旧 key」。
   */
  sizePt: number;
}

export interface LivePreviewOptions {
  /** 是否启用内联渲染（关闭时全部显示源码） */
  enabled: () => boolean;
  /**
   * 编译前缀（设置里的前缀代码；与整篇编译同源）。
   * 编译上下文（= 前缀 + 文档内 `#let` 定义）由本扩展**自己**从当前文档算：
   * 一次更新里 lexer 只跑一遍（见 typst-lex 的记忆化），也不必让页面为每次按键
   * 额外算一遍上下文（此前是 `$derived`，40k 文档每次按键多付 ~4.5ms）。
   */
  prefix: () => string;
  /** 取已渲染结果（父组件维护缓存；未命中返回 undefined） */
  lookup: (key: string) => MathRender | undefined;
  /** 需要渲染的公式（父组件负责去重 / 防抖 / 批量 invoke） */
  onRequest: (requests: MathRequest[]) => void;
  /**
   * 公式渲染字号（pt）。**必须等于正文字号**：写作模式的正文跟着文档走
   * （`--write-doc-px` = `textPt × 4/3`），所以公式也得用同一份 `textPt`，
   * 否则光标所在块里的公式比周围正文大一圈、也与同一公式在切片里的样子不一致
   * （PR #60 审查抓到写死 12pt 时大 9%）。缺省 = 源码模式的 10.5pt（`MATH_TEXT_PT`）。
   */
  mathSizePt?: () => number;
  /** 是否暗色主题（typst 产物是黑字透明底，暗色下需反色；见 mathWidgetTheme） */
  dark: () => boolean;
  /**
   * 写作模式的**块级渲染**：整篇编译出的"每块一张切片"（父组件每次 compile_blocks 后更新）。
   * 返回 null / 空数时整体关闭 —— 那时的行为与加这个功能之前**逐字节一致**
   * （源码模式、浏览器开发桩、后端没有该命令时都走这条路）。
   * 见 docs/文档模式渲染保真-调研.md。
   */
  blocks?: () => Block[] | null;
  /**
   * 视口内出现了"**能渲染但还没有切片**"的块（窗口化渲染的正常中间态）：
   * 父组件去抖后按新的视口窗口重编译一次。不传则永远等着下一次按键 —— 长文档里
   * 滚动到没渲过的区域会一直显示源码。
   */
  onBlocksNeeded?: () => void;
  /**
   * **点击定位**（阶段 2）：点在某张切片上的 `(xPt, yPt)`（页面坐标）→ 返回光标的
   * CodeMirror 位置。三种返回（报告 T2 / A1）：
   *  - `number`：命中位置；
   *  - `null`：**定不了位**（块表不精确、后端没有这份几何、命中不可用）→ 调用方退回"块首"；
   *  - `"cancelled"`：这次命中在等待期间**作废**（会话/文档/几何编号变了）→ 调用方必须
   *    整条取消，**不许**把它当 `null` 用（那会落一个明知过时的光标）。
   *
   * 真实实现在父组件（→ Rust 侧 `block_hit_test`，见 block-hit.ts / +page.svelte），
   * 这里只负责"量出点击点在切片里的相对位置"并把结果落在事务里。
   */
  onCropClick?: (req: {
    page: number;
    xPt: number;
    yPt: number;
    /** 被点那块的源码范围（CodeMirror 位置） */
    from: number;
    to: number;
  }) => Promise<number | null | "cancelled">;
  /**
   * **点切片里的链接**（阶段 3）：typst 的 `#link("…")[文字]` 在切片上是画出来的文字，
   * 点击时把 URL 交给父组件（→ opener 插件用系统浏览器打开）。不传则链接只是不可点的热区。
   */
  onOpenLink?: (href: string) => void;
  /**
   * 当前编译错误的区间（CodeMirror 位置）：**与诊断相交的块不许被切片盖住** ——
   * 波浪线画在源码上，被图片盖住的块里看不见（用户会看到"状态栏说有错，正文里找不到"）。
   * 入参是**正在算装饰的那个 state 的 doc**（不能取 `view.state`：StateField 计算时
   * view 上的 state 还是旧的）。
   */
  diagnosticRanges?: (doc: Text) => readonly { from: number; to: number }[];
}

/** 渲染结果更新后刷新装饰（父组件收齐一批渲染结果时 dispatch 一次） */
export const refreshLivePreview = StateEffect.define<null>();

/** 视口外多少字符范围内也提前渲染（滚动时不至于看到源码一闪） */
export const PREFETCH_MARGIN = 2000;
