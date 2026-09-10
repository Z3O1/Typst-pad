// 公式编译上下文：把「设置里的前缀代码」与「文档自身的顶层 #let 定义」拼成
// compile_math 的 context（见 typst_world::compile_math）。
//
// 为什么需要文档内定义：真实文档常写 `#let R = math.bb(R)` 这类宏，随后在公式里用 `$R$`；
// 只拿前缀当上下文的话这些公式渲染不出来（会退回源码显示，体验上像"公式没渲染"）。
// 保守规则：**只取单行的顶层 `#let` 语句、且不含内容块 `[...]`**——多行语句/内容块在
// 区域扫描里会被拆开（方括号内回到 markup），原样拼接可能得到残缺代码。宁可少取。
// 纯函数、可单测。
import { scanNonMarkupRegions } from "./typst-lex";

/**
 * 单行 `#let` 语句：`#let` + 名称 + 可选参数 + `=` + **非空**值，且值里不含内容块 `[`。
 * 要求「`=` 后有值」是为了跳过正在输入中的半截语句（`#let x =`）与内容块被区域扫描
 * 拆走后的残句（`#let a = ` + `[*粗*]`）——这类残句拼进上下文会让**所有**公式一起编译失败。
 */
const LET_RE = /^#let[ \t]+([A-Za-z_][A-Za-z0-9_-]*)[ \t]*(\([^()\n]*\))?[ \t]*=[ \t]*(\S[^\n[]*)$/;

/** 从文档里提取可用于公式编译的顶层 `#let` 定义（按文档顺序，同名保留最后一次） */
export function extractMathDefinitions(doc: string): string {
  const byName = new Map<string, string>();
  for (const region of scanNonMarkupRegions(doc)) {
    if (region.kind !== "code") continue;
    const text = doc.slice(region.from, region.to);
    const m = LET_RE.exec(text);
    if (!m) continue;
    // 同名重定义：保留最后一次（与"文档里后者覆盖前者"的直觉一致；
    // 若两者都拼进去会编译报"变量已存在"，反而整批公式都渲染不出来）
    byName.set(m[1], text.trim());
  }
  return [...byName.values()].join("\n");
}

/** 补尾随换行（非空且未以换行结尾时），避免与后续代码拼在同一行 */
function ensureTrailingNewline(text: string): string {
  if (text === "" || text.endsWith("\n")) return text;
  return text + "\n";
}

/**
 * 公式编译上下文 = 前缀代码 + 文档内 `#let` 定义（各自补尾随换行）。
 * 前缀在前：前缀里的定义优先（同名时文档定义会使其重复而报错，调用方有"仅前缀"的兜底重试）。
 */
export function buildMathContext(prefix: string, doc: string): string {
  const defs = extractMathDefinitions(doc);
  if (defs === "") return ensureTrailingNewline(prefix);
  return ensureTrailingNewline(prefix) + ensureTrailingNewline(defs);
}
