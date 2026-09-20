// 统一调试日志通道（调试改造 B）：
// - 开关：dev 构建默认开启；桌面构建可用命令行 --debug/--debug=1 开启（经 Tauri 命令
//   get_debug_flag 异步读取，见 +page.svelte onMount 的 setCliDebug）；任何构建可用
//   URL ?debug=1（仅本次会话）或 localStorage "typst-pad:debug"="1"（持久）开启。
// - 门控 logger 输出统一 [debug] 前缀便于过滤；关闭时除 enabled() 判定外零开销。
// - 开关判定为可注入纯函数（debugEnabledFrom），便于单元测试。
// 与 startup-timing.ts 并存：后者 [startup] 报告无条件输出（headless 性能回归抓取依赖），
// 本模块只管按需调试输出，不合并不删除。

/** 开关来源的环境读取器（测试注入替身点） */
export interface DebugEnv {
  /** 开发构建（import.meta.env.DEV） */
  isDev: boolean;
  /** 命令行 --debug 标志（Tauri get_debug_flag 返回；浏览器 dev 环境无此来源，传 false） */
  cliDebug: boolean;
  /** 读取 localStorage；不可用/异常返回 null */
  getLocalStorage: (key: string) => string | null;
  /** 读取 URL query 参数；无该参数返回 null */
  getUrlParam: (param: string) => string | null;
}

export const DEBUG_STORAGE_KEY = "typst-pad:debug";
export const DEBUG_URL_PARAM = "debug";

/**
 * 调试开关判定（纯函数）。优先级：dev 构建 > 命令行 --debug > URL ?debug=1 > localStorage。
 * - dev 构建（npm run dev / tauri dev）默认开启；
 * - 命令行 --debug/--debug=1 仅桌面构建生效（前端经 Tauri 命令异步读取，见 setCliDebug）；
 * - URL ?debug=1 一次性开启：页面加载时读取一次，不写 localStorage（选简单方案）；
 * - localStorage "typst-pad:debug" === "1" 可持久开启。
 */
export function debugEnabledFrom(env: DebugEnv): boolean {
  if (env.isDev) return true;
  if (env.cliDebug) return true;
  if (env.getUrlParam(DEBUG_URL_PARAM) === "1") return true;
  return env.getLocalStorage(DEBUG_STORAGE_KEY) === "1";
}

/** 运行时补开调试（CLI 标志为异步来源，invoke 返回后调用）：只增不减 */
export function enableDebug(current: boolean, cliFlag: boolean): boolean {
  return current || cliFlag;
}

/** 门控日志器接口：关闭时各方法直接返回，零开销 */
export interface DebugLog {
  /** 当前是否开启（调用方可用它跳过昂贵的日志参数构造） */
  enabled(): boolean;
  /** 输出一行 [debug] <tag> 日志 */
  log(tag: string, ...args: unknown[]): void;
  /** 开启 [debug] <tag> 分组 */
  group(tag: string): void;
  groupEnd(): void;
}

/** 由开关判定函数构造门控日志器；sink 默认 console（测试注入假 sink） */
export function createDebugLog(isEnabled: () => boolean, sink: Console = console): DebugLog {
  return {
    enabled: isEnabled,
    log(tag, ...args) {
      if (!isEnabled()) return;
      sink.log(`[debug] ${tag}`, ...args);
    },
    group(tag) {
      if (!isEnabled()) return;
      sink.group(`[debug] ${tag}`);
    },
    groupEnd() {
      if (!isEnabled()) return;
      sink.groupEnd();
    },
  };
}

/** 应用默认环境：浏览器侧读取 URL/localStorage（全部容错，SSR/隐私模式等不抛错） */
function defaultEnv(): DebugEnv {
  return {
    isDev: import.meta.env.DEV,
    cliDebug: false, // CLI 标志经 get_debug_flag 异步到达，见 setCliDebug
    getLocalStorage(key) {
      try {
        return typeof window === "undefined" ? null : window.localStorage.getItem(key);
      } catch {
        return null; // localStorage 不可用（隐私模式等）视同未开启
      }
    },
    getUrlParam(param) {
      try {
        if (typeof window === "undefined") return null;
        return new URLSearchParams(window.location.search).get(param);
      } catch {
        return null;
      }
    },
  };
}

// 应用级单例：模块加载时（页面启动）按环境初判开关；CLI 标志到达后经 setCliDebug 补开
let debugOn = debugEnabledFrom(defaultEnv());

/** CLI --debug 标志补开（+page.svelte onMount 中 isTauri() 时 invoke 后调用） */
export function setCliDebug(flag: boolean): void {
  debugOn = enableDebug(debugOn, flag);
}

export const dbg = createDebugLog(() => debugOn);
