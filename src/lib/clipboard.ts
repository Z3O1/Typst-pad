// 纯文本写入系统剪贴板（状态栏诊断浮层的「复制」按钮用）。
//
// 为什么主路径是 `document.execCommand("copy")` 而不是 `navigator.clipboard.writeText`：
// 与 `Editor.svelte` 里 cut/copy 的取舍完全一致（那段注释是原始决策记录）——
// execCommand 在用户手势（按钮点击）内**同步**执行、不需要任何权限、也不受"文档是否聚焦"
// 这类策略约束；`navigator.clipboard` 是异步的，在 WebView2 里受权限/聚焦影响，历史上踩过。
// 所以这里先走临时 textarea + execCommand，只有它明确失败（返回 false 或抛错）才退回
// navigator.clipboard 试一次；两条都失败就如实返回 false，由调用方给状态栏提示。
//
// 副作用控制：**不改光标位置、不夺焦点** —— 进函数前记下 activeElement，结束时若它仍在
// 文档里就还回去（临时 textarea 用完立刻移除，不留常驻节点）。

/**
 * 复制一段纯文本。成功返回 true；两条路径都失败返回 false（调用方据此提示"复制失败"）。
 * 注意：调用应当发生在用户手势内（点击/按键），否则剪贴板写入可能被引擎拒绝。
 */
export async function copyPlainText(text: string): Promise<boolean> {
  if (!text) return false;

  const active = document.activeElement as HTMLElement | null;

  // 主路径：临时 textarea + execCommand("copy")（同步、无需权限）
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // 移出视口且不可见，但**必须是可聚焦/可选择的**：不用 display:none 或 hidden（那样选不中）
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    // 先 focus 再 select：部分引擎里"没聚焦的元素上的选区"不算活动选区，execCommand 会返回 false。
    // 位置固定在视口外，聚焦也不会让页面滚动；结束时会把焦点还给原元素。
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) {
      restoreFocus(active);
      return true;
    }
  } catch {
    // 落到下面的兜底路径
  }

  // 兜底：异步剪贴板 API（可能因权限/聚焦失败）
  try {
    await navigator.clipboard.writeText(text);
    restoreFocus(active);
    return true;
  } catch {
    restoreFocus(active);
    return false;
  }
}

/** 把焦点还给复制前的元素（仅当它还在文档里；拿不到就什么都不做） */
function restoreFocus(el: HTMLElement | null): void {
  try {
    if (el && el.isConnected && typeof el.focus === "function") el.focus();
  } catch {
    // 恢复焦点失败无所谓，绝不能因此让复制本身报错
  }
}
