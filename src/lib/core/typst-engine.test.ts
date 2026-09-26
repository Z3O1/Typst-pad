// @vitest-environment jsdom

// typst-engine 单元测试：纯函数（诊断转换 / 页序拼接）+ invoke/dialog 已 mock 的
// compileToSvg / compileToPdf 契约映射。不接触真实 Tauri 环境。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  diagnosticToLocation,
  errorLocations,
  formatDiagnostic,
  composePages,
  compileToSvg,
  compileToPdf,
  compileBlocks,
  compileMath,
  listFontFamilies,
  defaultFontFamilies,
} from "./typst-engine";
import type { Diagnostic } from "./typst-engine";

/** 已保存文档的绝对路径（契约：documentPath = 已保存文档绝对路径 / null = 未保存） */
const SAVED_DOC_PATH = "C:\\proj\\main.typ";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

describe("diagnosticToLocation（Rust 结构化诊断 → 编辑器位置）", () => {
  it("1-based 行列原样透传；end 缺省回退为起点", () => {
    expect(diagnosticToLocation({ message: "m", severity: "error", line: 2, column: 9 })).toEqual({
      message: "m",
      line: 2,
      col: 9,
      endLine: 2,
      endCol: 9,
      path: undefined,
    });
  });

  it("end 显式传入时透传（独占终点语义）", () => {
    expect(
      diagnosticToLocation({
        message: "m",
        severity: "error",
        line: 1,
        column: 10,
        endLine: 1,
        endColumn: 11,
      }),
    ).toEqual({ message: "m", line: 1, col: 10, endLine: 1, endCol: 11, path: undefined });
  });

  it("path 透传", () => {
    expect(
      diagnosticToLocation({ message: "m", severity: "error", line: 1, column: 1, path: "lib.typ" })
        .path,
    ).toBe("lib.typ");
  });

  it("path: null（Rust 0.4.0~0.8.2 的写法）归一化为 undefined", () => {
    // 下游只认一种"这是主源"的表示（见 squiggleRanges）：不归一化的话 `null` 会被当成
    // "别的文件"⇒ 桌面版编译错误不画波浪线（2026-09-18 查出来的老 bug）
    expect(
      diagnosticToLocation({ message: "m", severity: "error", line: 1, column: 1, path: null }),
    ).toEqual({ message: "m", line: 1, col: 1, endLine: 1, endCol: 1, path: undefined });
  });
});

describe("errorLocations（错误级过滤）", () => {
  it("只取 error 级，跳过 warning 级", () => {
    const diags: Diagnostic[] = [
      { message: "e1", severity: "error", line: 1, column: 1 },
      { message: "w1", severity: "warning", line: 1, column: 1 },
      { message: "e2", severity: "error", line: 2, column: 3 },
    ];
    expect(errorLocations(diags).map((l) => l.message)).toEqual(["e1", "e2"]);
  });

  it("空列表 → 空数组", () => {
    expect(errorLocations([])).toEqual([]);
  });
});

describe("formatDiagnostic", () => {
  it("消息带位置后缀", () => {
    expect(formatDiagnostic({ message: "unexpected", severity: "error", line: 2, column: 9 })).toBe(
      "unexpected (行 2, 列 9)",
    );
  });
});

describe("composePages（每页 SVG → 预览容器 HTML）", () => {
  it("多页按页序拼接，页间插入分隔线", () => {
    const out = composePages(["<svg>A</svg>", "<svg>B</svg>", "<svg>C</svg>"]);
    expect(out).toBe(
      '<svg>A</svg><div class="page-separator"></div><svg>B</svg><div class="page-separator"></div><svg>C</svg>',
    );
  });

  it("单页不插分隔线", () => {
    expect(composePages(["<svg>A</svg>"])).toBe("<svg>A</svg>");
  });

  it("空数组 → 空字符串", () => {
    expect(composePages([])).toBe("");
  });
});

describe("compileToSvg（invoke 已 mock）", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("成功：页序拼接为 svg、pageCount = 页数，invoke 入参含已保存文档绝对路径", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      pages: ["<svg>p1</svg>", "<svg>p2</svg>"],
    });
    const r = await compileToSvg("#let x = 1", SAVED_DOC_PATH);
    expect(r).toEqual({
      ok: true,
      svg: '<svg>p1</svg><div class="page-separator"></div><svg>p2</svg>',
      pageCount: 2,
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("compile_doc", {
      src: "#let x = 1",
      documentPath: SAVED_DOC_PATH,
      // 预览页宽（预览重排）缺省为 null = 不重排（导出 PDF 走 export_pdf，不受它影响）
      previewWidthPt: null,
      fontFamilies: null,
      fontDirs: null,
    });
  });

  it("未保存新文档：documentPath 传 null", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, pages: ["<svg>p1</svg>"] });
    await compileToSvg("x", null);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("compile_doc", {
      src: "x",
      documentPath: null,
      previewWidthPt: null,
      fontFamilies: null,
      fontDirs: null,
    });
  });

  it("成功：携带 warnings（透传保留；UI 在状态栏警告徽标里展示）", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      pages: ["<svg>p1</svg>"],
      warnings: [{ message: "w", severity: "warning", line: 1, column: 1 }],
    });
    const r = await compileToSvg("x", SAVED_DOC_PATH);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toHaveLength(1);
  });

  it("失败：结构化诊断转错误位置列表，error 带首条消息+位置", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: false,
      diagnostics: [
        { message: "boom", severity: "error", line: 1, column: 9, endLine: 1, endColumn: 10 },
        { message: "warn", severity: "warning", line: 1, column: 1 },
      ],
    });
    const r = await compileToSvg("#let a = b", SAVED_DOC_PATH);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("boom (行 1, 列 9)");
      expect(r.errors).toEqual([
        { message: "boom", line: 1, col: 9, endLine: 1, endCol: 10, path: undefined },
      ]);
    }
  });

  it("ok:false 且无诊断：错误消息为通用文案", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: false, diagnostics: [] });
    const r = await compileToSvg("x", SAVED_DOC_PATH);
    if (!r.ok) {
      expect(r.error).toBe("编译失败：未生成产物");
      expect(r.errors).toEqual([]);
    }
  });

  it("invoke 抛异常：收敛为错误结果（errors 空，不向外抛）", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("IPC 失败"));
    const r = await compileToSvg("x", SAVED_DOC_PATH);
    if (!r.ok) {
      expect(r.error).toBe("IPC 失败");
      expect(r.errors).toEqual([]);
    }
  });
});

describe("compileToPdf（invoke / dialog 已 mock）", () => {
  // file-ops.savePdfDialog 有 isTauri() 门控（jsdom 无 __TAURI_INTERNALS__ 会直接返回
  // null）：模拟 Tauri 环境标记放行到 dialog 层
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(save).mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("选定目标路径后调用 export_pdf 直接落盘（documentPath = 已保存文档绝对路径）", async () => {
    vi.mocked(save).mockResolvedValue("C:\\out\\报告.pdf");
    vi.mocked(invoke).mockResolvedValue({ ok: true });
    const r = await compileToPdf("#let x = 1", SAVED_DOC_PATH, "报告.typ");
    expect(r).toEqual({ ok: true, targetPath: "C:\\out\\报告.pdf" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("export_pdf", {
      src: "#let x = 1",
      documentPath: SAVED_DOC_PATH,
      targetPath: "C:\\out\\报告.pdf",
      fontFamilies: null,
      fontDirs: null,
    });
  });

  it("字体配置透传：families/dirs 原样进 invoke（设置改了必须作用于导出）", async () => {
    vi.mocked(save).mockResolvedValue("C:\\out\\a.pdf");
    vi.mocked(invoke).mockResolvedValue({ ok: true });
    await compileToPdf("x", null, "a.typ", {
      families: ["Libertinus Serif", "SimSun"],
      dirs: ["D:\\fonts"],
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "export_pdf",
      expect.objectContaining({
        fontFamilies: ["Libertinus Serif", "SimSun"],
        fontDirs: ["D:\\fonts"],
      }),
    );
  });

  it("取消对话框：不调用 export_pdf，返回 cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);
    const r = await compileToPdf("x", null, "未命名.typ");
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("导出失败：error 透传", async () => {
    vi.mocked(save).mockResolvedValue("C:\\out\\a.pdf");
    vi.mocked(invoke).mockResolvedValue({ ok: false, error: "PDF 渲染失败" });
    const r = await compileToPdf("x", SAVED_DOC_PATH, "a.typ");
    expect(r).toEqual({ ok: false, cancelled: false, error: "PDF 渲染失败" });
  });

  it("ok:false 且无 error 字段：通用文案", async () => {
    vi.mocked(save).mockResolvedValue("C:\\out\\a.pdf");
    vi.mocked(invoke).mockResolvedValue({ ok: false });
    const r = await compileToPdf("x", SAVED_DOC_PATH, "a.typ");
    expect(r.ok).toBe(false);
    if (!r.ok && !r.cancelled) expect(r.error).toBe("PDF 导出失败：未生成产物");
  });
});

describe("字体命令包装（设置里的下拉数据源）", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("listFontFamilies：调用 list_font_families 并透传目录", async () => {
    vi.mocked(invoke).mockResolvedValue(["Libertinus Serif", "SimSun"]);
    const fonts = await listFontFamilies(["D:\\fonts"]);
    expect(fonts).toEqual(["Libertinus Serif", "SimSun"]);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("list_font_families", {
      fontDirs: ["D:\\fonts"],
    });
  });

  it("listFontFamilies：失败（浏览器环境/IPC 异常）返回空数组不抛", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no tauri"));
    expect(await listFontFamilies()).toEqual([]);
  });

  it("defaultFontFamilies：调用 default_font_families；失败返回空数组", async () => {
    vi.mocked(invoke).mockResolvedValue(["Libertinus Serif", "Noto Serif CJK SC"]);
    expect(await defaultFontFamilies()).toEqual(["Libertinus Serif", "Noto Serif CJK SC"]);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("default_font_families");
    vi.mocked(invoke).mockRejectedValue(new Error("no tauri"));
    expect(await defaultFontFamilies()).toEqual([]);
  });

  it("compileMath：字体配置与字号一起透传（公式里的中文也要跟随正文字体）", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      svg: "<svg/>",
      widthPt: 1,
      heightPt: 2,
      baselinePt: 1.5,
    });
    await compileMath("x^2", false, "", null, 12, { families: ["SimSun"], dirs: [] });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "compile_math",
      expect.objectContaining({ sizePt: 12, fontFamilies: ["SimSun"], fontDirs: [] }),
    );
  });
});

// 预览重排（2026-09-14）：页宽是**编译期输入**，必须原样传给 compile_doc
// （Rust 侧据此在编译源最前面注入 #set page(width/height/margin) 重新排版预览）
describe("compileToSvg：预览重排的页宽透传", () => {
  it("给了页宽就随本次编译一起发出（单位 pt，不换算）", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, pages: ["<svg>p1</svg>"] });
    await compileToSvg("x", null, undefined, 312.5);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "compile_doc",
      expect.objectContaining({ previewWidthPt: 312.5 }),
    );
  });

  it("没给页宽时传 null（= 不重排，走旧的等比缩放路径）", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, pages: ["<svg>p1</svg>"] });
    await compileToSvg("x", null);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "compile_doc",
      expect.objectContaining({ previewWidthPt: null }),
    );
  });
});

// 块级渲染的 IPC 契约（PR #60 审查抓到的那条真机 bug 的锁）：
// 「后端没实现这个命令」与「这次编译失败」必须分得开 —— 早先前者的判据是
// "`blocks` 是不是数组"，而真 Rust 侧失败时那个键被 serde 省略 ⇒ 真机上任何 typst 错误
// 都被读成"后端不支持"、退回整页预览（切片不撤、错误块不展开），而桩自己补了 `blocks: []`
// 所以验收全绿。契约现在只看 `ok`：失败结果**有没有 `blocks` 都算失败**。
describe("compileBlocks：区分「后端不支持」与「编译失败」", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("失败且**没有** blocks 键（真 Rust 侧早先的形状）→ 编译失败，不是 unavailable", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: false,
      pageWidthPt: 420,
      textPt: 11,
      diagnostics: [
        {
          message: "unknown variable: foo",
          severity: "error",
          line: 2,
          column: 3,
          endLine: 2,
          endColumn: 6,
        },
      ],
    });
    const res = await compileBlocks("= t\n#foo\n", 0, null, 420);
    expect(res.ok).toBe(false);
    expect(res.unavailable).toBe(false);
    if (res.ok || res.unavailable) throw new Error("期望「编译失败」");
    expect(res.errors.length).toBe(1);
    expect(res.error).toContain("unknown variable");
  });

  it("失败且**带** blocks: []（Rust 侧现在的形状）→ 同样是编译失败", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: false, blocks: [], pageWidthPt: 420, textPt: 11 });
    const res = await compileBlocks("= t\n", 0, null, 420);
    expect(res.ok).toBe(false);
    expect(res.unavailable).toBe(false);
  });

  it("ok:true 但没有块表 → 才算「后端没实现」（退回整页预览）", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, pageWidthPt: 420, textPt: 11 });
    const res = await compileBlocks("= t\n", 0, null, 420);
    expect(res.ok).toBe(false);
    expect(res.unavailable).toBe(true);
  });

  it("桩返回 null（&blocks=1 没开）→ unavailable", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const res = await compileBlocks("= t\n", 0, null, 420);
    expect(res.unavailable).toBe(true);
  });

  it("命令不存在 → unavailable（旧安装包走这条路）", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Command compile_blocks not found"));
    const res = await compileBlocks("= t\n", 0, null, 420);
    expect(res.unavailable).toBe(true);
  });

  it("**参数校验失败 / 命令内 panic 不算「不支持」**（别再退化成静默回退）", async () => {
    // 真实的 Tauri 报错长这样：invalid args `wantFrom` for command `compile_blocks`: ...
    vi.mocked(invoke).mockRejectedValue(
      new Error("invalid args `wantFrom` for command `compile_blocks`: invalid type: string"),
    );
    const res = await compileBlocks("= t\n", 0, null, 420);
    expect(res.unavailable).toBe(false);
    if (res.ok || res.unavailable) throw new Error("期望「错误结果」");
    expect(res.error).toContain("invalid args");
  });
});
