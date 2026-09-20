// 字体下拉的数据源：从 Rust 列字体族 + 「添加/移除额外字体目录」这两个动作。
//
// 从 `+page.svelte` 搬出来（原来 `refreshFontList` / `addFontDir` / `removeFontDir` 三个函数；
// `availableFonts` / `defaultFonts` / `fontsLoading` 三个 `$state` 与草稿里的目录**没搬**，
// 由 hooks 注入）。依赖全注入（`zoom-controller` / `math-queue` / `document-session` 同一套路），
// 单测里可以拿假 invoke 把两条容易写错的规则钉死：
//
// 1. 扫描用的目录必须先归一化（trim / 去空 / 去重）：同一个目录写两遍会让引擎扫两遍
//    （族名本身来自 Rust 真实注册的字体，结构上不可能在下拉里写出一个不存在的族名）。
// 2. 默认族列表是**静态**的：本模块每次仍会取一次（打开弹窗、增删目录），但**不许用空列表覆盖**
//    已经拿到的那份，否则"选中项 + 其余兜底"的兜底部分会被清空（生僻字掉回楷体/日文字形）。
//
// `loading` 一律在 `finally` 里复位：Rust 侧扫描失败（目录不存在/权限）时下拉不能永远转圈。
import { appendFontDir, withoutFontDir } from "./app-settings";
import { normalizeFontDirs } from "./font-settings";

export interface FontListHooks {
  /** Rust 侧列字体族（`list_font_families`） */
  listFamilies: (dirs: string[]) => Promise<string[]>;
  /** Rust 内置默认字体族（`default_font_families`） */
  defaultFamilies: () => Promise<string[]>;
  /** 系统目录选择器（用户点「添加目录」） */
  pickDir: () => Promise<string | null>;
  /** 下拉的选项（扫描结果） */
  setFamilies: (families: string[]) => void;
  /** Rust 内置默认族（只在拿到非空列表时被调用，见文件头第 2 条） */
  setDefaults: (families: string[]) => void;
  /** 下拉的加载态（`finally` 里复位） */
  setLoading: (loading: boolean) => void;
  /** 草稿里的字体目录（读/写）：增删只动**草稿**，点保存才生效（见 app-settings.ts） */
  dirs: () => string[];
  setDirs: (dirs: string[]) => void;
}

export interface FontList {
  /** 按给定目录重新扫描（打开设置弹窗、增删目录后） */
  refresh(dirs: string[]): Promise<void>;
  /** 「添加目录」：弹系统目录选择器 → 追加到草稿 → 重新扫描 */
  addDir(): Promise<void>;
  /** 「移除目录」：从草稿里删掉 → 重新扫描 */
  removeDir(dir: string): void;
}

export function createFontList(hooks: FontListHooks): FontList {
  async function refresh(dirs: string[]): Promise<void> {
    hooks.setLoading(true);
    try {
      const [families, defaults] = await Promise.all([
        hooks.listFamilies(normalizeFontDirs(dirs)),
        hooks.defaultFamilies(),
      ]);
      hooks.setFamilies(families);
      if (defaults.length > 0) hooks.setDefaults(defaults); // 拿不到就留着原来那份（见文件头第 2 条）
    } finally {
      hooks.setLoading(false);
    }
  }

  async function addDir(): Promise<void> {
    const dir = await hooks.pickDir();
    if (!dir) return;
    const next = appendFontDir(hooks.dirs(), dir);
    hooks.setDirs(next);
    await refresh(next);
  }

  function removeDir(dir: string): void {
    const next = withoutFontDir(hooks.dirs(), dir);
    hooks.setDirs(next);
    // fire-and-forget：扫描失败时这个 promise 会拒绝，页面靠全局 unhandledrejection 兜到状态栏
    // （与搬出来之前完全一样）。这里既不吞也不 await —— `loading` 仍由 `refresh` 的 `finally` 复位。
    void refresh(next);
  }

  return { refresh, addDir, removeDir };
}
