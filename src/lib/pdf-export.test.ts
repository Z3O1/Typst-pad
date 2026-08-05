// pdfFileName 单元测试（导出 PDF 文件名推导）
import { describe, it, expect } from "vitest";
import { pdfFileName } from "./pdf-export";

describe("pdfFileName", () => {
  it("报告.typ → 报告.pdf", () => {
    expect(pdfFileName("报告.typ")).toBe("报告.pdf");
  });

  it("a.b.typ → a.b.pdf（只剥最后一个扩展名）", () => {
    expect(pdfFileName("a.b.typ")).toBe("a.b.pdf");
  });

  it("无扩展名 → document.pdf", () => {
    expect(pdfFileName("未命名")).toBe("document.pdf");
  });

  it("x.TYP → x.pdf（大小写不敏感剥扩展名）", () => {
    expect(pdfFileName("x.TYP")).toBe("x.pdf");
  });
});
