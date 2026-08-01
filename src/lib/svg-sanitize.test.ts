// SVG 净化模块单元测试（jsdom 环境）
import { describe, it, expect } from "vitest";
import { isSafeUrl, parseSvgStrict, sanitizeSvg } from "./svg-sanitize";

describe("isSafeUrl", () => {
  it("放行 http/https/mailto", () => {
    expect(isSafeUrl("https://example.com/a?b=1")).toBe(true);
    expect(isSafeUrl("http://example.com")).toBe(true);
    expect(isSafeUrl("mailto:user@example.com")).toBe(true);
  });

  it("放行相对 URL 与锚点", () => {
    expect(isSafeUrl("relative/path.svg")).toBe(true);
    expect(isSafeUrl("#glyph-1")).toBe(true);
    expect(isSafeUrl("./page2")).toBe(true);
  });

  it("拒绝 javascript: 及其空白/大小写变体", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("JAVASCRIPT:alert(1)")).toBe(false);
    expect(isSafeUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeUrl("  javascript:alert(1)")).toBe(false);
  });

  it("拒绝其他危险协议", () => {
    expect(isSafeUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("vbscript:x")).toBe(false);
    expect(isSafeUrl("blob:http://x/1")).toBe(false);
  });

  it("data:image 仅放行光栅格式，拒绝 svg+xml", () => {
    expect(isSafeUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeUrl("data:image/jpeg;base64,/9j/")).toBe(true);
    expect(isSafeUrl("data:image/gif;base64,R0lGOD")).toBe(true);
    expect(isSafeUrl("data:image/webp;base64,UklGR")).toBe(true);
    expect(isSafeUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isSafeUrl("data:image/pngx;base64,x")).toBe(false);
  });
});

describe("parseSvgStrict", () => {
  it("合法 SVG 直接解析", () => {
    const doc = parseSvgStrict('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"/></svg>');
    expect(doc.querySelector("rect")).not.toBeNull();
  });

  it("含裸 & 的 SVG 被修复并保留语义（合法实体不双转义）", () => {
    const doc = parseSvgStrict(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>A &amp; B & C</text></svg>',
    );
    expect(doc.querySelector("text")?.textContent).toBe("A & B & C");
  });

  it("严重损坏的 SVG 抛错（fail-closed）", () => {
    expect(() => parseSvgStrict("<svg><unclosed")).toThrow("SVG 解析失败");
  });
});

describe("sanitizeSvg", () => {
  const evilSvg = `<svg xmlns="http://www.w3.org/2000/svg">
    <a href="javascript:alert(1)" onclick="x()">link</a>
    <image src="data:text/html,x"/>
    <script>alert(1)</script>
    <foreignObject><div>html</div></foreignObject>
  </svg>`;

  it("移除事件属性与危险 URL 属性", () => {
    const out = sanitizeSvg(evilSvg);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("data:text/html");
  });

  it("移除 script 与 foreignObject 元素", () => {
    const out = sanitizeSvg(evilSvg);
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("foreignobject");
  });

  it("保留合法 SVG 结构与相对引用", () => {
    const good = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs><g id="g1"><path d="M0 0"/></g></defs>
      <use xlink:href="#g1"/>
      <a href="https://example.com"><text>ok</text></a>
    </svg>`;
    const out = sanitizeSvg(good);
    expect(out).toContain('href="#g1"');
    expect(out).toContain("https://example.com");
    expect(out).toContain('id="g1"');
  });

  it("返回可序列化的 XML 字符串", () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(out).toMatch(/^<svg/);
  });
});
