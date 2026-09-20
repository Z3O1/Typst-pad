// PDF 导出辅助：由文档标题推导导出文件名。
/** 由文档标题推导 PDF 文件名："报告.typ" → "报告.pdf"；无扩展名/空名 → "document.pdf"；"a.b.typ" → "a.b.pdf" */
export function pdfFileName(title: string): string {
  // 剥掉最后一个扩展名（保留中间点，如 "a.b.typ" → "a.b"）；
  // 标题中没有点（无扩展名）或剥离后为空（空名/纯扩展名）统一回退 "document"
  const dot = title.lastIndexOf(".");
  const base = dot > 0 ? title.slice(0, dot) : "";
  return (base || "document") + ".pdf";
}
