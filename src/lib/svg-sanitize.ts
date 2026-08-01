// SVG 净化：Typst 编译产物可含用户可控的链接/图片地址（如 #link），
// 在注入 innerHTML 前移除事件属性、危险协议 URL 与可执行内容元素。
// 独立模块以便单元测试（不依赖 wasm 编译引擎）。

const URL_ATTRS = ["href", "xlink:href", "src"];

// 链接协议白名单（<a href>/xlink:href）；相对 URL 与锚点（#...）放行
const ALLOWED_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];
// 图片 data URI 仅允许光栅格式（data:image/svg+xml 可含脚本，不放行）
const ALLOWED_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)([;,])/;

/** 判断 URL 属性值是否安全：协议白名单 + 相对/锚点 + 光栅 data:image 例外 */
export function isSafeUrl(value: string): boolean {
  const v = value.replace(/\s+/g, "").toLowerCase();
  if (ALLOWED_DATA_IMAGE.test(v)) return true;
  // 无协议前缀 = 相对 URL 或锚点
  if (!/^[a-z][a-z0-9+.-]*:/.test(v)) return true;
  return ALLOWED_LINK_PROTOCOLS.some((p) => v.startsWith(p));
}

/** 严格解析 SVG；失败时先修复未转义的裸 & 再试一次（XML 要求 & 必须转义） */
export function parseSvgStrict(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (!doc.querySelector("parsererror")) return doc;
  const fixed = svg.replace(
    /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g,
    "&amp;",
  );
  const doc2 = new DOMParser().parseFromString(fixed, "image/svg+xml");
  if (doc2.querySelector("parsererror")) {
    throw new Error("SVG 解析失败，已阻止注入");
  }
  return doc2;
}

/** 净化 SVG 字符串，返回可安全注入 innerHTML 的结果 */
export function sanitizeSvg(svg: string): string {
  const doc = parseSvgStrict(svg);
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  // 先收集再移除：遍历中直接 remove() 会中断 TreeWalker 游标（jsdom 行为差异）
  const toRemove: Element[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    // 移除全部事件处理属性（on*，覆盖 onclick/onpointer*/onwheel 等）
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    // 移除可执行内容元素（typst 输出不使用这些）
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "foreignobject") {
      toRemove.push(el);
    }
  }
  for (const el of toRemove) el.remove();
  return new XMLSerializer().serializeToString(doc);
}
