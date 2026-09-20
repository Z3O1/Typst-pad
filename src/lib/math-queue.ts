// 公式渲染队列（从 +page.svelte 搬出来）：编辑器请求 → 去重 → 120ms 去抖 → 逐个交给 Rust 编译
// → 结果进缓存（有上限）→ 通知编辑器重整装饰。
//
// 依赖全部注入（编译命令、上下文、定时器、版本号回调），单测里用假编译把这几条钉住：
//
// 1. **重复请求不入队**：已缓存、或已在队列里的 key 直接跳过；整批一个都没新增时**不排定时器**
//    （编辑器每次重整装饰都会把视口内的公式全报一遍，不去重就是每帧一次编译）。
// 2. **公式优先**：写作模式下、且有挂着的整篇块编译时，把块编译往后推到
//    `MATH_COMPILE_HEADSTART_MS`。两者共用 Rust 侧一把编译锁，不推的话"打完公式半天不显示"
//    （实测慢编译桩下版面对齐要等 338ms）。**只往后推、绝不取消**：公式持续到来时块编译就一直
//    被推迟，直到公式那一批渲完才轮到它。
// 3. **缓存上限按插入顺序淘汰**（`MATH_CACHE_LIMIT`）：键按公式文本累积，长会话会堆很多条
//    （每条一份 SVG）；被淘汰的若仍在视口内，编辑器会重新请求并渲染。
// 4. **失败也进缓存**（避免反复重试），但**只有成功才自增版本号** —— 失败时装饰集不变，
//    自增只会白跑一次全量重建。
// 5. **上下文兜底**：用请求自带上下文编译失败、且它与"仅前缀"不同时，退回仅前缀再试一次
//    （文档内定义本身有错、或与前缀重名时，至少还能渲染不依赖它们的公式）。

import type { MathRequest } from "./live-preview";
import type { MathRender } from "./typst-engine";

/** 公式请求的去抖时长（连续输入时不会每个按键都排队，停手后一次性补齐） */
export const MATH_DEBOUNCE_MS = 120;
/** 公式渲染先跑：把挂着的块编译推到这个时刻（比公式自身的去抖稍晚一点） */
export const MATH_COMPILE_HEADSTART_MS = 240;
/** 公式渲染缓存条数上限（超出按插入顺序淘汰最早的） */
export const MATH_CACHE_LIMIT = 500;

export interface MathQueueHooks {
  /** 真正编译一条公式（页面接 typst-engine.compileMath，带上 filePath / sizePt / 字体配置） */
  compile(req: MathRequest): Promise<MathRender>;
  /** 现在是写作模式吗（只有写作模式的整篇编译才需要让路） */
  isWriteMode(): boolean;
  /** 有挂着的整篇块编译吗（页面那个变量同时兼任这个判据，见 writeCompileTimer 的注解） */
  hasPendingBlockCompile(): boolean;
  /** 把挂着的整篇编译重新计时到 ms 之后（页面负责"跑完置回 undefined"） */
  rescheduleBlockCompile(ms: number): void;
  /** 仅前缀的兜底上下文（prefixSource()：启用前缀时是补过尾换行的前缀，否则空串） */
  prefixContext(): string;
  /** 渲染成功 → 通知编辑器重整装饰（mathVersion++） */
  bumpVersion(): void;
  /** 调试日志（`math ok/fail display/inline "body"`） */
  log(message: string): void;
  /** 排一个定时器（单测注入假时钟；回调是 async，页面用 `setTimeout(() => void fn(), ms)` 接） */
  schedule(fn: () => Promise<void>, ms: number): number;
  clearTimer(id: number): void;
}

export interface MathQueue {
  /** 编辑器请求渲染（视口内出现未缓存的公式时触发；整批去重后去抖） */
  request(requests: MathRequest[]): void;
  /** 编辑器查缓存（渲染结果它自己渲染成 widget，不经过页面） */
  lookup(key: string): MathRender | undefined;
  /** 文档切换（打开/新建/重读）：缓存与队列全部作废（include 根与上下文都可能变） */
  reset(): void;
  /** 组件卸载：取消还没落地的批次（不再动版本号，界面马上就不在了） */
  dispose(): void;
}

export function createMathQueue(hooks: MathQueueHooks): MathQueue {
  // 缓存不需要响应式（变更后靠"版本号"通知编辑器重整装饰）
  const cache = new Map<string, MathRender>();
  // 已排队待渲染的 key（防止同一公式重复入队）
  const pending = new Set<string>();
  let queue: MathRequest[] = [];
  let timer: number | undefined;

  /** 逐个渲染队列中的公式（Rust 侧编译本身串行），每完成一个就刷新装饰 */
  async function drain(): Promise<void> {
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    // 仅前缀的兜底上下文：文档内定义本身有错、或与前缀重名时，至少还能渲染不依赖它们的公式
    const prefixOnly = hooks.prefixContext();
    for (const req of batch) {
      // 用请求自带的上下文编译（与生成缓存键时一致，见 MathRequest.context 的说明）
      // 字号也来自请求（与生成缓存键时用的那个一致，见 MathRequest.sizePt 的说明）：
      // 写作模式跟着文档字号走，源码模式 10.5pt
      let render = await hooks.compile(req);
      if (!render.ok && prefixOnly !== req.context) {
        const fallback = await hooks.compile({ ...req, context: prefixOnly });
        if (fallback.ok) render = fallback;
      }
      cache.set(req.key, render);
      // 缓存上限：超限按插入顺序淘汰最早的条目；若它仍在视口内，编辑器会重新请求并渲染
      while (cache.size > MATH_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      pending.delete(req.key);
      // 只有渲染成功才需要重整装饰：失败的结果同样进缓存（避免反复重试），
      // 但装饰集不变（仍显示源码），自增版本号只会白跑一次全量重建
      if (render.ok) hooks.bumpVersion();
      hooks.log(
        `math ${render.ok ? "ok" : "fail"} ${req.display ? "display" : "inline"} ${JSON.stringify(req.body)}`,
      );
    }
  }

  function request(requests: MathRequest[]): void {
    let added = false;
    for (const req of requests) {
      if (cache.has(req.key) || pending.has(req.key)) continue;
      pending.add(req.key);
      queue.push(req);
      added = true;
    }
    if (!added) return; // 一条新的都没有：连定时器都不排（否则每帧一次空批）
    hooks.clearTimer(timer as number);
    // 有公式要渲时，把挂着的整篇块编译往后推：让公式先拿到编译锁（见文件头第 2 条）
    if (hooks.isWriteMode() && hooks.hasPendingBlockCompile()) {
      hooks.rescheduleBlockCompile(MATH_COMPILE_HEADSTART_MS);
    }
    timer = hooks.schedule(drain, MATH_DEBOUNCE_MS);
  }

  function reset(): void {
    cache.clear();
    pending.clear();
    queue = [];
    hooks.clearTimer(timer as number);
    timer = undefined;
    hooks.bumpVersion();
  }

  function dispose(): void {
    queue = [];
    hooks.clearTimer(timer as number);
    timer = undefined;
  }

  return {
    request,
    lookup: (key) => cache.get(key),
    reset,
    dispose,
  };
}
