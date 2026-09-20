// 公式渲染队列：编辑器请求渲染 → 去重 → 防抖批量 → 逐个 invoke Rust → 结果进缓存。
//
// 从 `+page.svelte` 搬出来（原来散在页面里 ~90 行，和文件/编译/弹窗的状态混在一起）。
// 依赖全部由 hooks 注入（**照着 `zoom-controller.ts` 的先例**），所以单测里可以用假时钟、
// 假编译把队列行为钉死，不需要 DOM 也不需要 Tauri。
//
// **为什么不用 `.svelte.ts` 的 runes**：`vitest.config.ts` 是独立配置、没有 svelte 插件，
// `.svelte.ts` 里的 `$state` 在单测里会直接 ReferenceError（实测风险，不冒）。响应式代次由
// 页面自己持有 `$state`，这里通过 `onRendered` 通知 —— 一个数字比一个新文件扩展名便宜得多。
//
// 三条契约（改这里之前先读）：
// 1. **失败也进缓存**：失败结果同样 `cache.set`，否则编辑器每秒都会重新请求同一个坏公式。
// 2. **只有成功才通知代次**：失败时装饰集不变（仍显示源码），自增代次只会白跑一次全量重建。
// 3. **有公式要渲时把挂着的块编译往后推**（`deferBlockCompile`）：两者共用 Rust 侧同一把编译锁，
//    公式是小活、整篇块编译是几十~几百毫秒，不让路就会出现"打完公式半天不显示"。
import type { MathRequest } from "./live-preview";
import type { MathRender } from "../core/typst-engine";

/** 公式渲染去抖：连续输入时不是每个按键都排队，停手后一次性补齐 */
export const MATH_DEBOUNCE_MS = 120;
/** 缓存条数上限（超出按插入顺序淘汰最早的；见 `cacheLimit`） */
export const MATH_CACHE_LIMIT = 500;

export interface MathQueueHooks {
  /**
   * 编译单个公式。`context` 由本模块决定（通常是请求自带的，失败时可能是"仅前缀"的兜底），
   * 调用方负责补上自己的 documentPath / 字体参数。
   */
  compile: (req: MathRequest, context: string) => Promise<MathRender>;
  /** 仅前缀的兜底上下文（文档内定义有错、或与前缀重名时，至少还能渲染不依赖它们的公式） */
  fallbackContext: () => string;
  /** 一个公式渲染完了（`ok` = 成功）。页面据此自增装饰代次；失败不通知 */
  onRendered: (ok: boolean) => void;
  /** 有公式入队时调用：把挂着的块编译往后推（见文件头第 3 条契约） */
  deferBlockCompile: () => void;
  log: (message: string) => void;
  /** 缓存上限（单测用小值；缺省 `MATH_CACHE_LIMIT`） */
  cacheLimit?: number;
}

export interface MathQueue {
  /** 编辑器请求渲染一批公式（视口内出现未缓存公式时触发） */
  handleRequest: (requests: MathRequest[]) => void;
  /** 取已渲染结果（未命中返回 undefined → 编辑器保持源码显示） */
  lookup: (key: string) => MathRender | undefined;
  /** 文档切换（打开/新建/重读）：缓存作废（include 根与上下文都可能变），队列与定时器一起清掉 */
  reset: () => void;
  /** 仅诊断/测试：当前排队等待渲染的公式数 */
  queued: () => number;
}

export function createMathQueue(hooks: MathQueueHooks): MathQueue {
  // Map 本身不需要响应式：变更靠页面持有的代次通知编辑器重整装饰
  const cache = new Map<string, MathRender>();
  /** 已排队待渲染的 key（防止同一公式重复入队） */
  const pending = new Set<string>();
  let queue: MathRequest[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = hooks.cacheLimit ?? MATH_CACHE_LIMIT;

  /** 逐个渲染队列中的公式（Rust 侧编译本身串行），每完成一个就报一次代次 */
  async function drain(): Promise<void> {
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    const fallback = hooks.fallbackContext();
    for (const req of batch) {
      // 用请求自带的上下文与字号：它们**必须**与生成缓存键时用的一致（见 MathRequest 的说明）
      let render = await hooks.compile(req, req.context);
      if (!render.ok && fallback !== req.context) {
        const retry = await hooks.compile(req, fallback);
        if (retry.ok) render = retry;
      }
      cache.set(req.key, render);
      // 超限按插入顺序淘汰最早的；若它仍在视口内，编辑器会重新请求并渲染
      while (cache.size > limit) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      pending.delete(req.key);
      if (render.ok) hooks.onRendered(true);
      hooks.log(
        `math ${render.ok ? "ok" : "fail"} ${req.display ? "display" : "inline"} ${JSON.stringify(req.body)}`,
      );
    }
  }

  function handleRequest(requests: MathRequest[]): void {
    let added = false;
    for (const req of requests) {
      if (cache.has(req.key) || pending.has(req.key)) continue;
      pending.add(req.key);
      queue.push(req);
      added = true;
    }
    if (!added) return;
    clearTimeout(timer);
    // 让公式先拿到那把共享的编译锁（见文件头第 3 条契约）
    hooks.deferBlockCompile();
    timer = setTimeout(() => void drain(), MATH_DEBOUNCE_MS);
  }

  function reset(): void {
    cache.clear();
    pending.clear();
    queue = [];
    clearTimeout(timer);
  }

  return {
    handleRequest,
    lookup: (key) => cache.get(key),
    reset,
    queued: () => queue.length,
  };
}
