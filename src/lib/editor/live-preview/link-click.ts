// **可编辑段落里的链接：Ctrl/Cmd+点击打开**（typora-parity 审计 P0-1 的链接那一半）。
//
// 为什么需要修饰键：链接在可编辑段落里是**真实文本**，普通点击必须留给"把光标放进去改字"
// （Typora 同款）。打开 URL 因此绑在 Ctrl/Cmd+点击上，与 Typora 的 `Ctrl+点击链接` 一致。
// **切片里的链接不受影响**：那是 `<a class="cm-block-crop-link">` 热区，普通点击即打开
// （见 `widgets.ts` 的 BlockCropWidget），本模块明确跳过切片内部的事件。
//
// 判定链（任何一步不成立都交回默认，绝不吞点击）：
//  1. 写作模式、左键、带 Ctrl/Cmd、事件不在切片里；
//  2. 命中一处在**当前文档**里成立的 `link` 装饰（用与呈现同源的 `scanLinks` 结果，见 `doc-scan`）；
//  3. 从 `#link("url")` 那段源码里取出字面量 URL。
//
// 位置解析优先用**事件目标的 DOM**（`.cm-markup-link` 是呈现层给链接文字套的 mark），
// 因为它不依赖布局测量 —— jsdom 里 `posAtCoords` 恒为 null，而真实浏览器两者都可用。
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { scanDocument } from "./doc-scan";
import type { LivePreviewOptions } from "./options";

/** `#link("url")` 代码区间的字面量 URL；不是这种形态返回 null（与呈现层同一个正则口径） */
const LINK_CALL_RE = /^#link\s*\(\s*"([^"]*)"\s*\)$/;

/** 某一段源码是不是白名单形态的链接调用，是则给回 URL */
export function linkUrlFromCall(source: string): string | null {
  const m = LINK_CALL_RE.exec(source);
  return m ? m[1] : null;
}

export function createLinkClick(opts: LivePreviewOptions): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!opts.enabled()) return false;
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return false;
      // 切片里的链接有自己的热区（普通点击即打开），别在这里重复处理
      if (target.closest(".cm-block-crop")) return false;
      // 位置：先按命中的 `.cm-markup-link` 取（不依赖布局），再退回坐标
      let pos: number | null = null;
      const mark = target.closest(".cm-markup-link");
      if (mark) {
        try {
          pos = view.posAtDOM(mark, 0);
        } catch {
          pos = null;
        }
      }
      if (pos === null) pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const scan = scanDocument(view.state, opts.prefix());
      for (const item of scan.markup) {
        if (item.kind !== "link") continue;
        const from = Math.min(item.content.from, ...item.markers.map((m) => m.from));
        const to = Math.max(item.content.to, ...item.markers.map((m) => m.to));
        if (pos < from || pos > to) continue;
        const call = item.markers[0];
        const href = call ? linkUrlFromCall(scan.docString.slice(call.from, call.to)) : null;
        if (!href) continue;
        // 打开链接是"打开"语义：不挪光标（与热区同一条），也不让浏览器抢走焦点
        opts.onOpenLink?.(href);
        event.preventDefault();
        return true;
      }
      return false;
    },
  });
}
