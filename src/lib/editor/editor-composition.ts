/**
 * 兼容 CodeMirror 的 DOM 输入和启用时的原生 EditContext 输入。
 * 后者的合成事件发到 contentDOM.editContext，不保证再发到 DOM 元素。
 */
export function observeEditorComposition(
  content: HTMLElement & { editContext?: EventTarget | null },
  onChange: (active: boolean) => void,
): () => void {
  const targets = [content, content.editContext].filter(
    (target): target is EventTarget => !!target,
  );
  let active = false;
  let disposed = false;
  let epoch = 0;
  const start = () => {
    epoch++;
    if (!active) {
      active = true;
      onChange(true);
    }
  };
  const end = () => {
    const current = epoch;
    // 先让 CodeMirror 处理最终文本，且不会因 DOM/EditContext 双事件重复调度。
    queueMicrotask(() => {
      if (disposed || current !== epoch || !active) return;
      active = false;
      onChange(false);
    });
  };
  for (const target of targets) {
    target.addEventListener("compositionstart", start);
    target.addEventListener("compositionend", end);
  }
  content.addEventListener("blur", end);
  return () => {
    disposed = true;
    epoch++;
    for (const target of targets) {
      target.removeEventListener("compositionstart", start);
      target.removeEventListener("compositionend", end);
    }
    content.removeEventListener("blur", end);
  };
}
