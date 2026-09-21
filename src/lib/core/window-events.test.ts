// 窗口级事件两条规则的单测：拖放（覆盖层开关 + 只认 .typ + 什么时候才提示"仅支持 .typ"）与
// 关闭确认（按内容判定，空文档不许拦）。不碰 Tauri / DOM。
import { beforeEach, describe, expect, it } from "vitest";
import { REJECT_DROP_STATUS, createCloseGuard, createDropHandler } from "./window-events";

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
    drop.handle("over", ["/tmp/a.typ"]);
    drop.handle("enter");
    expect(active).toEqual([true, true]);
    expect(opened).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("drop 里有 .typ：收掉覆盖层并打开它（多个 .typ 取第一个）", () => {
    const drop = make();
    drop.handle("drop", ["/tmp/图.png", "/tmp/甲.typ", "/tmp/乙.typ"]);
    expect(active).toEqual([false]);
    expect(opened).toEqual(["/tmp/甲.typ"]);
    expect(statuses).toEqual([]);
  });

  it("drop 里没有 .typ、但确实拿到了路径：收掉覆盖层 + 提示「仅支持打开 .typ 文件」", () => {
    const drop = make();
    drop.handle("drop", ["/tmp/图.png"]);
    expect(active).toEqual([false]);
    expect(opened).toEqual([]);
    expect(statuses).toEqual([REJECT_DROP_STATUS]);
    expect(REJECT_DROP_STATUS).toBe("仅支持打开 .typ 文件");
  });

  it("drop 里一个路径都没有（拖到窗口空白处之类）：只收覆盖层，**不**无中生有一句报错", () => {
    const drop = make();
    drop.handle("drop", []);
    drop.handle("drop"); // 有些平台不给 paths
    expect(active).toEqual([false, false]);
    expect(statuses).toEqual([]);
  });

  it("leave（或任何其它收尾态）：收掉覆盖层，不打开也不提示", () => {
    const drop = make();
    drop.handle("leave");
    drop.handle("cancel");
    expect(active).toEqual([false, false]);
    expect(opened).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("大小写不敏感：`.TYP` 也算（`isTypPath` 的口径）", () => {
    const drop = make();
    drop.handle("drop", ["/tmp/论文.TYP"]);
    expect(opened).toEqual(["/tmp/论文.TYP"]);
  });
});

describe("createCloseGuard", () => {
  let prompted: number;
  let prevented: number;

  function make(doc: string, dirty: boolean) {
    const guard = createCloseGuard({
      doc: () => doc,
      dirty: () => dirty,
      prompt: () => {
        prompted += 1;
      },
    });
    return {
      /** 模拟一次关闭请求，返回是否被拦下 */
      close(): boolean {
        let stopped = false;
        guard.handle({
          preventDefault: () => {
            stopped = true;
            prevented += 1;
          },
        });
        return stopped;
      },
    };
  }

  beforeEach(() => {
    prompted = 0;
    prevented = 0;
  });

  it("有未保存内容：拦下关闭并弹确认（preventDefault + prompt）", () => {
    const { close } = make("写了一半", true);
    expect(close()).toBe(true);
    expect(prevented).toBe(1);
    expect(prompted).toBe(1);
  });

  it("干净文档：直接放行（不拦、不弹）", () => {
    const { close } = make("写完了", false);
    expect(close()).toBe(false);
    expect(prevented).toBe(0);
    expect(prompted).toBe(0);
  });

  it("**空文档**：`dirty` 仍是 true 也不拦（输入过又删光 = 没什么可丢的）", () => {
    for (const blank of ["", "   ", "\n\t "]) {
      const { close } = make(blank, true);
      expect(close()).toBe(false);
    }
    expect(prevented).toBe(0);
    expect(prompted).toBe(0);
  });
});
