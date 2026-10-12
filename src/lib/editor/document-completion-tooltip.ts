import { Prec } from "@codemirror/state";
import { acceptCompletion, closeCompletion, completionStatus } from "@codemirror/autocomplete";
import {
  EditorView,
  getTooltip,
  keymap,
  repositionTooltips,
  showTooltip,
  ViewPlugin,
  type Rect,
} from "@codemirror/view";

export interface DocumentInputAnchor {
  left: number;
  top: number;
  height: number;
}

export function documentCompletionCoords(anchor: DocumentInputAnchor): Rect {
  return {
    left: anchor.left,
    right: anchor.left + 1,
    top: anchor.top,
    bottom: anchor.top + anchor.height,
  };
}

/** 只改现有补全视图的锚点；候选、键位、鼠标接受和生命周期仍由 CM 管理。 */
export function anchorCompletionTooltips(
  view: EditorView,
  getAnchor: () => DocumentInputAnchor | null,
) {
  for (const tooltip of view.state.facet(showTooltip)) {
    if (!tooltip) continue;
    const tooltipView = getTooltip(view, tooltip);
    if (!tooltipView?.dom.classList.contains("cm-tooltip-autocomplete")) continue;
    tooltipView.getCoords = (pos) => {
      const anchor = getAnchor();
      return anchor
        ? documentCompletionCoords(anchor)
        : (view.coordsAtPos(pos) ?? { left: 0, right: 0, top: -10000, bottom: -10000 });
    };
  }
}

export function documentCompletionTooltips(getAnchor: () => DocumentInputAnchor | null) {
  return [
    // Enter 的自定义段落/列表键位优先级高于 basicSetup；候选先接受再回退。
    Prec.highest(keymap.of([{ key: "Enter", run: acceptCompletion }])),
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (
            event.key !== "Escape" ||
            event.isComposing ||
            view.composing ||
            view.compositionStarted ||
            !completionStatus(view.state)
          )
            return false;
          closeCompletion(view);
          // 不把同一次 Esc 继续交给页面的退出源码展开处理。
          event.stopPropagation();
          event.preventDefault();
          return true;
        },
      }),
    ),
    ViewPlugin.define((view) => {
      anchorCompletionTooltips(view, getAnchor);
      return {
        update() {
          anchorCompletionTooltips(view, getAnchor);
          repositionTooltips(view);
        },
      };
    }),
  ];
}
