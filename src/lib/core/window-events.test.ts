// 窗口级事件两条规则的单测：拖放（覆盖层开关 + 只认 .typ + 什么时候才提示"仅支持 .typ"）与
// 关闭确认（按内容判定、空文档不许拦、每次请求都重新读状态）。**不调用** Tauri / DOM API。
import { beforeEach, describe, expect, it } from "vitest";
import { REJECT_DROP_STATUS, createCloseGuard, createDropHandler } from "./window-events";
import type { DragPayload } from "./window-events";

describe("createDropHandler", () => {
  let active: boolean[];
  let opened: string[];
  let statuses: string[];

  function make() {
    return createDropHandler({
      setDragActive: (v) => active.push(v),
      openPath: (path) => opened.push(path),
      setStatus: (text) => statuses.push(text),
    });
  }

  beforeEach(() => {
    active = [];
    opened = [];
    statuses = [];
  });

  it("over / enter：亮覆盖层，不打开也不提示", () => {
    const drop = make();
    drop.handle({ type: "over", paths: ["/tmp/a.typ"] }); // enter/over 也带 paths，但不该被用
    drop.handle({ type: "enter" });
    expect(active).toEqual([true, true]);
    expect(opened).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("over → drop 的完整序列：覆盖层亮起来再收掉", () => {
    const drop = make();
    drop.handle({ type: "over" });
    drop.handle({ type: "drop", paths: ["/tmp/a.typ"] });
    expect(active).toEqual([true, false]);
    expect(opened).toEqual(["/tmp/a.typ"]);
  });

  it("drop 里有 .typ：收掉覆盖层并打开它（多个 .typ 取第一个）", () => {
    const drop = make();
    drop.handle({ type: "drop", paths: ["/tmp/图.png", "/tmp/甲.typ", "/tmp/乙.typ"] });
    expect(active).toEqual([false]);
    expect(opened).toEqual(["/tmp/甲.typ"]);
    expect(statuses).toEqual([]); // 成功路径不写状态栏
  });

  it("drop 里没有 .typ、但确实拿到了路径：收掉覆盖层 + 提示「仅支持打开 .typ 文件」", () => {
    const drop = make();
    drop.handle({ type: "drop", paths: ["/tmp/图.png"] });
    expect(active).toEqual([false]);
    expect(opened).toEqual([]);
    expect(statuses).toEqual([REJECT_DROP_STATUS]);
    expect(REJECT_DROP_STATUS).toBe("仅支持打开 .typ 文件");
  });

  it("drop 里一个路径都没有（拖到窗口空白处之类）：只收覆盖层，**不**无中生有一句报错", () => {
    const drop = make();
    drop.handle({ type: "drop", paths: [] });
    drop.handle({ type: "drop" }); // 有些平台不给 paths
    expect(active).toEqual([false, false]);
    expect(opened).toEqual([]); // 也不许拿空串去打开
    expect(statuses).toEqual([]);
  });

  it("leave（或任何其它收尾态）：收掉覆盖层，不打开也不提示", () => {
    const drop = make();
    drop.handle({ type: "leave" });
    drop.handle({ type: "cancel" });
    expect(active).toEqual([false, false]);
    expect(opened).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("大小写不敏感：`.TYP` 也算（`isTypPath` 的口径）", () => {
    const drop = make();
    drop.handle({ type: "drop", paths: ["/tmp/论文.TYP"] });
    expect(active).toEqual([false]);
    expect(opened).toEqual(["/tmp/论文.TYP"]);
    expect(statuses).toEqual([]);
  });
});

describe("createCloseGuard", () => {
  let prompted: number;
  let prevented: number;

  /** 模拟一次关闭请求；返回是否被拦下（= `preventDefault` 被调用） */
  function close(guard: ReturnType<typeof createCloseGuard>): boolean {
    let stopped = false;
    guard.handle({
      preventDefault: () => {
        stopped = true;
        prevented += 1;
      },
    });
    return stopped;
  }

  beforeEach(() => {
    prompted = 0;
    prevented = 0;
  });

  it("有未保存内容：拦下关闭并弹确认（preventDefault + prompt）", () => {
    const guard = createCloseGuard({
      doc: () => "写了一半",
      dirty: () => true,
      prompt: () => {
        prompted += 1;
      },
    });
    expect(close(guard)).toBe(true);
    expect(prevented).toBe(1);
    expect(prompted).toBe(1);
  });

  it("干净文档：直接放行（不拦、不弹）", () => {
    const guard = createCloseGuard({
      doc: () => "写完了",
      dirty: () => false,
      prompt: () => {
        prompted += 1;
      },
    });
    expect(close(guard)).toBe(false);
    expect(prevented).toBe(0);
    expect(prompted).toBe(0);
  });

  it("**空文档**：`dirty` 仍是 true 也不拦（输入过又删光 = 没什么可丢的）", () => {
    for (const blank of ["", "   ", "\n\t "]) {
      const guard = createCloseGuard({
        doc: () => blank,
        dirty: () => true,
        prompt: () => {
          prompted += 1;
        },
      });
      expect(close(guard), `空文档 ${JSON.stringify(blank)} 不该拦关闭`).toBe(false);
    }
    expect(prevented).toBe(0);
    expect(prompted).toBe(0);
  });

  it("**每次关闭请求都重新读 `doc`/`dirty`**（缓存成创建那一刻的值 = 关闭确认永不弹、静默丢内容）", () => {
    let text = "";
    let dirty = false;
    const guard = createCloseGuard({
      doc: () => text,
      dirty: () => dirty,
      prompt: () => {
        prompted += 1;
      },
    });
    expect(close(guard)).toBe(false); // 创建时是空文档：放行

    text = "写了一半"; // 创建之后才变脏（真实场景：用户开始打字）
    dirty = true;
    expect(close(guard)).toBe(true); // 必须按"当下"的内容拦
    expect(prompted).toBe(1);
  });
});
