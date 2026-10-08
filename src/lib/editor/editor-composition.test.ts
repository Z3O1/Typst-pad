// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { observeEditorComposition } from "./editor-composition";

function setup(native = false) {
  const content = document.createElement("div");
  const context = new EventTarget();
  if (native) Object.defineProperty(content, "editContext", { value: context });
  const change = vi.fn();
  const dispose = observeEditorComposition(content, change);
  return { content, context, change, dispose };
}
const emit = (target: EventTarget, name: string) => target.dispatchEvent(new Event(name));

describe("编辑器合成观测", () => {
  it("传统 DOM 合成先暂停，再在最终文本微任务后恢复", async () => {
    const { content, change, dispose } = setup();
    emit(content, "compositionstart");
    emit(content, "compositionstart");
    expect(change.mock.calls).toEqual([[true]]);
    emit(content, "compositionend");
    expect(change.mock.calls).toEqual([[true]]);
    await Promise.resolve();
    expect(change.mock.calls).toEqual([[true], [false]]);
    dispose();
  });

  it("EditContext 的事件不需要转发到 DOM 也能暂停/恢复", async () => {
    const { context, change, dispose } = setup(true);
    emit(context, "compositionstart");
    expect(change).toHaveBeenLastCalledWith(true);
    emit(context, "compositionend");
    await Promise.resolve();
    expect(change.mock.calls).toEqual([[true], [false]]);
    dispose();
  });

  it("DOM 与 EditContext 的双事件不重复冻结或编译", async () => {
    const { content, context, change, dispose } = setup(true);
    emit(context, "compositionstart");
    emit(content, "compositionstart");
    emit(content, "compositionend");
    emit(context, "compositionend");
    await Promise.resolve();
    expect(change.mock.calls).toEqual([[true], [false]]);
    dispose();
  });

  it("新的合成作废已排队的旧 end，失焦结束活动合成", async () => {
    const { content, context, change, dispose } = setup(true);
    emit(context, "compositionstart");
    emit(context, "compositionend");
    emit(context, "compositionstart");
    await Promise.resolve();
    expect(change.mock.calls).toEqual([[true]]);
    emit(content, "blur");
    await Promise.resolve();
    expect(change.mock.calls).toEqual([[true], [false]]);
    dispose();
  });

  it("卸载清理两条事件路径并作废结束微任务", async () => {
    const { content, context, change, dispose } = setup(true);
    emit(context, "compositionstart");
    emit(context, "compositionend");
    dispose();
    await Promise.resolve();
    emit(content, "compositionstart");
    emit(context, "compositionstart");
    expect(change.mock.calls).toEqual([[true]]);
  });
});
