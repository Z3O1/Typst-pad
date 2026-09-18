// 更新流程纯决策层单元测试。
//
// 两条红线的可判定版本：
//  ① 点过「稍后」之后，自动检查 **不弹窗、也不动状态文字**，但状态栏入口仍在（updateNoticeText）；
//  ② 只有 planDismiss 会产出 dismissedAt —— 页面那条 Esc/"关闭"路径不经过它，绝不等于替用户点「稍后」。
import { describe, it, expect } from "vitest";
import {
  CHECKING_STATUS,
  INSTALLING_STATUS,
  LATEST_STATUS,
  UNSUPPORTED_STATUS,
  planDismiss,
  planInstallResult,
  planInstallStart,
  planUpdateCheck,
  updateNoticeText,
} from "./update-flow";
import { UPDATE_DISMISS_NOTICE } from "./update-utils";
import type { AvailableUpdate, CheckOutcome } from "./updater";

const update = (over: Partial<AvailableUpdate> = {}): AvailableUpdate => ({
  handle: {} as AvailableUpdate["handle"],
  version: "0.9.1",
  currentVersion: "0.9.0",
  notes: "### Fixed\n- 修了一处",
  date: "2026-09-19T00:00:00Z",
  ...over,
});

describe("updateNoticeText：状态栏入口文案", () => {
  it("有可用新版本 → 可更新到 vX", () => {
    expect(
      updateNoticeText({ kind: "available", version: "0.9.1", currentVersion: "0.9.0", notes: "" }),
    ).toBe("可更新到 v0.9.1");
  });

  it("下载中：百分比已知给百分比", () => {
    expect(
      updateNoticeText({
        kind: "downloading",
        version: "0.9.1",
        progress: { downloaded: 500, total: 1000, percent: 50 },
      }),
    ).toBe("正在下载更新 v0.9.1（50%）");
  });

  it("下载中：总长未知（percent=null）只说已下载量", () => {
    expect(
      updateNoticeText({
        kind: "downloading",
        version: "0.9.1",
        progress: { downloaded: 1536, total: 0, percent: null },
      }),
    ).toContain("已下载");
  });

  it("其余状态没有提示（含「稍后」之后的自动检查结果 —— 入口另说）", () => {
    expect(updateNoticeText({ kind: "idle" })).toBeNull();
    expect(updateNoticeText({ kind: "checking", manual: false })).toBeNull();
    expect(updateNoticeText({ kind: "latest" })).toBeNull();
    expect(updateNoticeText({ kind: "installing", version: "0.9.1" })).toBeNull();
    expect(updateNoticeText({ kind: "error", message: "网络不通" })).toBeNull();
  });
});

describe("planUpdateCheck：手动检查必须有反馈", () => {
  it("已是最新 → 状态栏说出来", () => {
    const plan = planUpdateCheck({ kind: "none" }, { manual: true, dismissedAt: null });
    expect(plan).toEqual({ flow: { kind: "latest" }, status: LATEST_STATUS, openDialog: false });
  });

  it("非 Tauri 环境（浏览器）→ 说明仅桌面版可用", () => {
    const plan = planUpdateCheck({ kind: "unsupported" }, { manual: true, dismissedAt: null });
    expect(plan.flow).toEqual({ kind: "idle" });
    expect(plan.status).toBe(UNSUPPORTED_STATUS);
  });

  it("检查失败 → 状态栏带原因", () => {
    const plan = planUpdateCheck(
      { kind: "error", message: "网络不通" },
      { manual: true, dismissedAt: null },
    );
    expect(plan.flow).toEqual({ kind: "error", message: "网络不通" });
    expect(plan.status).toBe("检查更新失败：网络不通");
    expect(plan.openDialog).toBe(false);
  });
});

describe("planUpdateCheck：自动检查保持安静", () => {
  it("没更新：状态机记成 latest，状态栏一个字都不动", () => {
    const plan = planUpdateCheck({ kind: "none" }, { manual: false, dismissedAt: null });
    expect(plan.flow).toEqual({ kind: "latest" });
    expect(plan.status).toBeNull();
  });

  it("失败：状态机记错误，但状态栏不动（不打扰写作的人）", () => {
    const plan = planUpdateCheck(
      { kind: "error", message: "网络不通" },
      { manual: false, dismissedAt: null },
    );
    expect(plan.flow).toEqual({ kind: "error", message: "网络不通" });
    expect(plan.status).toBeNull();
  });
});

describe("红线①：点过「稍后」之后，自动检查只留状态栏入口", () => {
  it("自动 + 没点过稍后 → 弹窗 + 状态栏提示", () => {
    const plan = planUpdateCheck(
      { kind: "available", update: update() },
      { manual: false, dismissedAt: null },
    );
    expect(plan.flow).toEqual({
      kind: "available",
      version: "0.9.1",
      currentVersion: "0.9.0",
      notes: "### Fixed\n- 修了一处",
    });
    expect(plan.status).toBe("发现新版本 v0.9.1");
    expect(plan.openDialog).toBe(true);
  });

  it("自动 + 已点过稍后 → 不弹窗、**状态文字也不动**，但状态机仍进 available（入口还在）", () => {
    const plan = planUpdateCheck(
      { kind: "available", update: update() },
      { manual: false, dismissedAt: 1_700_000_000_000 },
    );
    expect(plan.openDialog).toBe(false);
    expect(plan.status).toBeNull();
    expect(updateNoticeText(plan.flow)).toBe("可更新到 v0.9.1"); // 状态栏那个「回头路」还在
  });

  it("手动检查永远弹窗（即使上一秒刚点过「稍后」）", () => {
    const plan = planUpdateCheck(
      { kind: "available", update: update() },
      { manual: true, dismissedAt: 1_700_000_000_000 },
    );
    expect(plan.openDialog).toBe(true);
    expect(plan.status).toBe("发现新版本 v0.9.1");
  });

  it("检查结果里**没有** dismissedAt 这一项（它只由 planDismiss 产出，见红线②）", () => {
    const plan = planUpdateCheck(
      { kind: "available", update: update() },
      { manual: false, dismissedAt: null },
    );
    expect("dismissedAt" in plan).toBe(false);
  });
});

describe("红线②：只有「稍后」会写 dismissedAt", () => {
  it("planDismiss 记下时刻并说明后果", () => {
    expect(planDismiss(1234)).toEqual({ dismissedAt: 1234, status: UPDATE_DISMISS_NOTICE });
  });

  it("「稍后」的文案明确告诉用户还能手动检查", () => {
    expect(UPDATE_DISMISS_NOTICE).toContain("检查更新");
  });
});

describe("安装：开始 / 成功 / 失败", () => {
  it("开始下载：进度从 0 且总长未知（percent = null）", () => {
    expect(planInstallStart("0.9.1")).toEqual({
      kind: "downloading",
      version: "0.9.1",
      progress: { downloaded: 0, total: 0, percent: null },
    });
  });

  it("成功 → 切到安装态，不弹窗", () => {
    const plan = planInstallResult({ ok: true }, "0.9.1");
    expect(plan).toEqual({
      flow: { kind: "installing", version: "0.9.1" },
      status: INSTALLING_STATUS,
      openDialog: false,
    });
  });

  it("失败 → 切到错误态，**必须弹窗**（否则点了按钮好像什么也没发生）", () => {
    const plan = planInstallResult({ ok: false, message: "签名不对" }, "0.9.1");
    expect(plan).toEqual({
      flow: { kind: "error", message: "签名不对" },
      status: "更新失败：签名不对",
      openDialog: true,
    });
  });

  it("检查中的文案常量没被改坏（手动检查第一句反馈）", () => {
    expect(CHECKING_STATUS).toBe("正在检查更新…");
  });
});

describe("检查结果的类型可判别", () => {
  it("四种结果各走各的分支（穷尽性由 TS 保证，这里锁行为）", () => {
    const outcomes: CheckOutcome[] = [
      { kind: "none" },
      { kind: "unsupported" },
      { kind: "error", message: "x" },
      { kind: "available", update: update() },
    ];
    const flows = outcomes.map(
      (o) => planUpdateCheck(o, { manual: false, dismissedAt: null }).flow.kind,
    );
    expect(flows).toEqual(["latest", "idle", "error", "available"]);
  });
});
