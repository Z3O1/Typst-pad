// 桩的**假公式渲染**：结构模仿 typst 的 `compile_math` 产物（贴边 viewBox + 透明底 + 文本），
// 尺寸/基线给合理量级，用于在浏览器里验证「公式内联渲染」的布局与对齐（**非真实排版**）。
//
// 两条路：
// ① 注入了**真实产物**（`window.__DEV_MATH_FIXTURES`，由 `npm run fixtures:math` 导出）且
//    body + 风格 + 字号三者都对得上 → 直接用真 SVG（见 realMath）；
// ② 否则退回假 SVG（带虚线边框与红字，**一眼看得出不是 typst**，实测踩过"把假产物当真渲染"）。
import { escapeXml } from "./fake-layout";

/** 注入页面的真实公式产物（见 scripts/browser-check/wysiwyg-visual.mjs 与 Rust 的 dump_math_fixtures） */
interface RealMathFixture {
  body: string;
  display: boolean;
  /** 编译字号（pt）：必须与被请求的字号一致，否则尺寸/基线都不对 */
  sizePt?: number;
  svg: string;
  widthPt: number;
  heightPt: number;
  baselinePt: number;
}

/**
 * 取注入的真实公式产物：body + 风格 + **字号** 三者都要对上（字号不同尺寸就不对，
 * 宁可退回假 SVG 也不要给出尺寸错误的"真产物"）。夹具未标字号时按旧格式放行。
 */
export function realMath(
  body: string,
  display: boolean,
  sizePt: number,
): RealMathFixture | undefined {
  const list = (window as unknown as { __DEV_MATH_FIXTURES?: RealMathFixture[] })
    .__DEV_MATH_FIXTURES;
  if (!Array.isArray(list)) return undefined;
  return list.find(
    (f) =>
      f.body === body &&
      f.display === display &&
      (f.sizePt === undefined || Math.abs(f.sizePt - sizePt) < 0.01),
  );
}

export function fakeMath(body: string, display: boolean) {
  const widthPt = Math.max(4, body.length * 5.2);
  const heightPt = display ? 16 : 7.2;
  const baselinePt = display ? 8.4 : 5.6;
  // 虚线边框 + 「dev 假渲染」标注：这个桩画的**不是** typst 排版，必须一眼看得出来，
  // 否则很容易把假产物当成真渲染去排查（实测踩过：以为公式渲染错了）。
  const svg =
    `<svg viewBox="0 0 ${widthPt} ${heightPt}" width="${widthPt}pt" height="${heightPt}pt" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0.4" y="0.4" width="${Math.max(0, widthPt - 0.8)}" height="${Math.max(0, heightPt - 0.8)}" ` +
    `fill="none" stroke="#e05555" stroke-width="0.8" stroke-dasharray="2 1.5"/>` +
    `<text x="0" y="${baselinePt}" font-size="10.5" ` +
    `font-style="italic" font-family="New Computer Modern Math, serif" fill="#000000">` +
    `${escapeXml(body)}</text></svg>`;
  return { ok: true, svg, widthPt, heightPt, baselinePt };
}
