// 本地 .typ 库文件的路径/消息纯函数工具（不依赖 wasm / tauri，可单元测试）。
// 虚拟路径约定：相对文档目录、斜杠分隔、无前导斜杠（如 "lib.typ"、"chapters/a.typ"）。

/**
 * 取路径所在目录（兼容 Windows 反斜杠与 POSIX 斜杠；"C:\a\b.typ" → "C:\a"，
 * "/a/b.typ" → "/a"；无分隔符返回原始串）。
 */
export function dirOfPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (idx === -1) return path;
  return path.slice(0, idx);
}

/**
 * 绝对路径 → 相对文档目录的虚拟相对路径（"C:\proj\lib\a.typ" + "C:\proj" →
 * "lib/a.typ"，分隔符统一为 /）。目录不匹配、路径在目录之外或含 `..` 段返回 null。
 */
export function toVirtualRelPath(absPath: string, dir: string): string | null {
  const normAbs = absPath.replace(/\\/g, "/");
  const normDir = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = normDir === "" ? "" : normDir + "/";
  // Windows 路径大小写不敏感（盘符开头 ⇒ Windows 风格）：匹配前统一小写；POSIX 保持敏感
  const caseFolded = /^[A-Za-z]:/.test(prefix);
  const startAbs = caseFolded ? normAbs.toLowerCase() : normAbs;
  const startPrefix = caseFolded ? prefix.toLowerCase() : prefix;
  if (!startAbs.startsWith(startPrefix)) return null;
  const rel = normAbs.slice(prefix.length).replace(/^\/+/, "");
  if (rel === "") return null;
  if (rel.split("/").some((s) => s === ".." || s === ".")) return null;
  return rel;
}

/**
 * 把 {path, content} 列表按文档目录转成 registerLocalLibraries 的入参；
 * 自动过滤目录外路径、含 `..` 段者、与 /main.typ 同名者（basename 大小写不敏感，
 * 防覆盖 main 的 shadow）。
 */
export function libraryVirtualPaths(
  files: Array<{ path: string; content: string }>,
  dir: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    const rel = toVirtualRelPath(f.path, dir);
    if (!rel) continue; // 目录外 / 含 .. 段
    if (rel.toLowerCase() === "main.typ") continue; // 防覆盖 /main.typ 的 shadow
    out[rel] = f.content;
  }
  return out;
}

/**
 * 编译失败的状态栏文案：errorCount>0 → "编译错误：N 处"；否则 →
 * "编译错误：" + error（截断到 ~120 字符，防状态栏溢出）。
 */
export function formatCompileFailMessage(errorCount: number, error: string): string {
  if (errorCount > 0) return `编译错误：${errorCount} 处`;
  const msg = error.length > 120 ? error.slice(0, 120) + "…" : error;
  return `编译错误：${msg}`;
}
