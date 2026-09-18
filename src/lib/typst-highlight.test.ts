import { describe, expect, it } from "vitest";
import { tags } from "@lezer/highlight";
import type { Tag } from "@lezer/highlight";
import { defaultHighlightStyle } from "@codemirror/language";
import { typstHeadingHighlightStyle } from "./typst-highlight";

// 这组用例锁的是「标题没有下划线」这件事本身：下划线来自**编辑器默认高亮**
// （`defaultHighlightStyle`，basicSetup 自带）——typst 包把整棵 Heading 子树标成 tags.heading，
// 于是标题正文也吃到默认高亮那条 `textDecoration: underline`。我们只能再挂一份把它压掉，
// 所以"压掉了什么、为什么压得住"都要有断言兜住。
//
// 历史：最早以为是 typst 包自带的高亮；0.6.0 换到无 wasm 的 Lezer 入口时才发现它那份里已经
// 没有 heading 规则，而下划线照旧 —— 真正那条在 @codemirror/language 里（浏览器验收当场抓到）。
describe("标题高亮覆盖（压掉默认高亮给标题加的下划线）", () => {
  it("给标题写的是 text-decoration: none，且带 !important（不依赖样式表顺序）", () => {
    expect(rulesOf(typstHeadingHighlightStyle)).toMatch(/text-decoration:\s*none\s*!important/);
  });

  it("默认高亮那份给标题的类与我们的不是同一个类 —— CM6 是「类并集」，靠 !important 取胜", () => {
    const ours = classNameOf(typstHeadingHighlightStyle);
    const theirs = classNameOf(defaultHighlightStyle);
    expect(ours).not.toBe("");
    expect(theirs).not.toBe("");
    expect(ours).not.toBe(theirs);
  });

  it("前提仍然成立：默认高亮确实在给标题加下划线（哪天上游修好了，这条会红，补丁就可以删）", () => {
    expect(rulesOf(defaultHighlightStyle)).toMatch(/text-decoration:\s*underline/);
  });

  // 下面两条用 jsdom 真实跑一遍级联：CM6 把两份高亮样式的类都加在同一个元素上（类并集），
  // 最终算出来的 text-decoration 必须是我们的 none —— 这就是补丁生效的判据。
  // 取值一律用 text-decoration **简写**：jsdom 没实现 text-decoration-line 长写（恒为 none）。
  it("两个类同在时算出来是 none", () => {
    mountStyles([rulesOf(defaultHighlightStyle), rulesOf(typstHeadingHighlightStyle)]);
    const el = headingElement([classNameOf(defaultHighlightStyle), classNameOf(typstHeadingHighlightStyle)]);
    expect(getComputedStyle(el).textDecoration).toBe("none");
  });

  it("对照：同样一条 none 规则、没有 !important 又排在默认那份之前时，会被盖回 underline", () => {
    mountStyles([".cm-plain-none {text-decoration: none;}", rulesOf(defaultHighlightStyle)]);
    const el = headingElement([classNameOf(defaultHighlightStyle), "cm-plain-none"]);
    expect(getComputedStyle(el).textDecoration).toBe("underline");
  });
});

/** 取高亮样式生成的 CSS 规则（`HighlightStyle.module` 的类型是 `StyleModule | null`） */
function rulesOf(style: { module: { getRules(): string } | null }): string {
  return style.module?.getRules() ?? "";
}

/** 取高亮样式给标题标签分配的那个类名（`style()` 返回 `string | null`） */
function classNameOf(style: { style(tags: readonly Tag[]): string | null }): string {
  return style.style([tags.heading]) ?? "";
}

/** 把给定的 CSS 规则依次挂进文档（数组顺序即样式表顺序） */
function mountStyles(rules: string[]): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
}

/** 造一个带上这些类的标题元素（模拟 CM6 把两份高亮的类并集加在同一段文字上） */
function headingElement(classes: (string | null)[]): HTMLElement {
  const el = document.createElement("span");
  el.textContent = "1";
  el.className = classes.filter((c): c is string => !!c).join(" ");
  document.body.appendChild(el);
  return el;
}
