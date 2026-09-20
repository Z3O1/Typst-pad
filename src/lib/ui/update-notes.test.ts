import { describe, expect, it } from "vitest";
import { NOTES_MAX_CHARS, renderUpdateNotes } from "./update-notes";

describe("renderUpdateNotes", () => {
  it("空输入返回空串", () => {
    expect(renderUpdateNotes("")).toBe("");
  });

  it("HTML 一律转义（远端清单不可信）", () => {
    const html = renderUpdateNotes(`<img src=x onerror="alert(1)"> & <b>粗</b>`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;b&gt;粗&lt;/b&gt;");
  });

  it("标题：# ~ ### → h4（CHANGELOG 的 `### Added` 就是这档），更深 → h5", () => {
    expect(renderUpdateNotes("### Fixed")).toBe("<h4>Fixed</h4>");
    expect(renderUpdateNotes("## Added")).toBe("<h4>Added</h4>");
    expect(renderUpdateNotes("#### 细节")).toBe("<h5>细节</h5>");
  });

  it("无序列表（含两空格缩进的嵌套；嵌套列表开在上一层 li 内部，是合法 HTML）", () => {
    const html = renderUpdateNotes(
      ["- 顶层", "  - 二级", "  - 二级二", "- 顶层二", "1. 编号", "2. 编号二"].join("\n"),
    );
    expect(html).toBe(
      "<ul><li>顶层<ul><li>二级</li><li>二级二</li></ul></li><li>顶层二</li></ul>" +
        "<ol><li>编号</li><li>编号二</li></ol>",
    );
  });

  it("粗体与行内代码", () => {
    expect(renderUpdateNotes("- **中文不再被渲染成楷体**")).toBe(
      "<ul><li><strong>中文不再被渲染成楷体</strong></li></ul>",
    );
    expect(renderUpdateNotes("- 运行 `npm test` 试试")).toBe(
      "<ul><li>运行 <code>npm test</code> 试试</li></ul>",
    );
  });

  it("代码片段里的 `**` 不会被当成粗体", () => {
    expect(renderUpdateNotes("- 代码 `a**b**` 保持原样")).toBe(
      "<ul><li>代码 <code>a**b**</code> 保持原样</li></ul>",
    );
  });

  it("未闭合的 `**` 原样显示，不吞掉后面的文字", () => {
    const html = renderUpdateNotes("- 半截 **强调 后面还有字");
    expect(html).toContain("半截 **强调 后面还有字");
    expect(html).not.toContain("<strong>");
  });

  it("连续普通行合成一段，空行分段", () => {
    expect(renderUpdateNotes("第一行\n第二行\n\n第三行")).toBe("<p>第一行 第二行</p><p>第三行</p>");
  });

  it("分隔线 → hr", () => {
    expect(renderUpdateNotes("a\n\n---\n\nb")).toBe("<p>a</p><hr /><p>b</p>");
  });

  it("链接不做成 <a>（点了会把应用窗口导航出去），保持原文文本", () => {
    const html = renderUpdateNotes("见 [文档](https://example.com/x)");
    expect(html).not.toContain("<a ");
    expect(html).toContain("[文档](https://example.com/x)");
  });

  it("真实的 0.7.4 更新说明节选：不留 `###` / `**` / 反引号原文", () => {
    const notes = [
      "### Fixed",
      "",
      '- **"改了字体没生效"的四条路一起修**：① 族名写错（如中文名"微软雅黑"）时 typst **只发 warning 不报错**。',
      "  - 现在状态栏出现警告徽标，`font-warnings.ts` 给出中文提示。",
      "",
      "### Changed",
      "",
      "- 版本号 0.7.3 → 0.7.4（package.json / tauri.conf.json / Cargo.toml 三处一致，Cargo.lock 根 crate 同步）。",
    ].join("\n");
    const html = renderUpdateNotes(notes);
    expect(html).toContain("<h4>Fixed</h4>");
    expect(html).toContain("<h4>Changed</h4>");
    expect(html).toContain("<strong>");
    expect(html).toContain("<code>font-warnings.ts</code>");
    expect(html).not.toContain("###");
    expect(html).not.toContain("**");
    expect(html).not.toContain("`");
  });

  it("超长说明截断并明说", () => {
    const html = renderUpdateNotes("长".repeat(NOTES_MAX_CHARS + 100));
    expect(html).toContain("更新说明过长，已截断");
    expect(html.length).toBeLessThan(NOTES_MAX_CHARS + 200);
  });
});
