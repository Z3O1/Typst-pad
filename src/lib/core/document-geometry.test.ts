import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { hitTestDocument, locateDocumentCursor, locateDocumentSelection } from "./typst-engine";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());

const caret = { offset: 6, page: 2, xPt: 10, yPt: 20, heightPt: 12, rotationDeg: 90 };
const quad = {
  from: 3,
  to: 6,
  page: 2,
  points: [
    [10, 20],
    [15, 20],
    [15, 32],
    [10, 32],
  ],
};

describe("整页光标与选区 IPC", () => {
  it("原样传递产物编号、页外坐标和字节范围", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(caret)
      .mockResolvedValueOnce(caret)
      .mockResolvedValueOnce([quad]);
    expect(await hitTestDocument(9, 2, -10, 20)).toEqual(caret);
    expect(await locateDocumentCursor(9, 6)).toEqual(caret);
    expect(await locateDocumentSelection(9, 3, 6)).toEqual([quad]);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["document_hit_test", { geometryId: 9, page: 2, xPt: -10, yPt: 20 }],
      ["document_cursor", { geometryId: 9, offset: 6 }],
      ["document_selection", { geometryId: 9, from: 3, to: 6 }],
    ]);
  });

  it("拒绝无效光标和四边形，不把坏几何写入 DOM", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ ...caret, offset: -1 })
      .mockResolvedValueOnce({ ...caret, rotationDeg: NaN })
      .mockResolvedValueOnce([
        quad,
        { ...quad, page: 0 },
        {
          ...quad,
          points: [
            [Infinity, 20],
            [15, 20],
            [15, 32],
            [10, 32],
          ],
        },
        { ...quad, points: [[10, 20]] },
      ]);
    expect(await hitTestDocument(9, 2, 10, 20)).toBeNull();
    expect(await locateDocumentCursor(9, 6)).toBeNull();
    expect(await locateDocumentSelection(9, 3, 6)).toEqual([quad]);
  });

  it("IPC 失败或没有快照时返回空交互，不中断输入", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("快照已失效"));
    expect(await hitTestDocument(9, 2, 10, 20)).toBeNull();
    expect(await locateDocumentCursor(9, 6)).toBeNull();
    expect(await locateDocumentSelection(9, 3, 6)).toEqual([]);
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await locateDocumentSelection(9, 3, 6)).toEqual([]);
  });
});
