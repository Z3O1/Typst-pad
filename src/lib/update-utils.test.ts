// update-utils 单元测试：自动更新的纯逻辑（进度换算、错误文案、说明裁剪、"别再自动弹窗"判定）。
// Tauri 侧的 check/downloadAndInstall 不在这里测（浏览器里没有真实 updater），
// 但"进度怎么显示""错误怎么说人话""点过稍后之后还弹不弹"这些判断全在这里。
//
// 注意这里**没有**"多久才该检查一次"的用例：那道 6 小时节流已经删掉（启动时每次都查），
// 见 update-utils.ts 的注解与 wysiwyg.mjs 第 34 组的回归网。
import { describe, it, expect } from "vitest";
import {
  AUTO_CHECK_DELAY_MS,
  UPDATE_DISMISS_NOTICE,
  formatBytes,
  progressFrom,
  formatProgress,
  describeUpdateError,
  isUpdatePromptSuppressed,
} from "./update-utils";

describe("启动自动检查的延迟", () => {
  it("延迟是正数且不为 0（不能在 mount 里立刻打网络，会跟首屏抢那几秒）", () => {
    expect(AUTO_CHECK_DELAY_MS).toBeGreaterThan(0);
  });
});

describe("isUpdatePromptSuppressed（点过「稍后」就不再自动弹窗）", () => {
  it("没点过（null / undefined / 0 / NaN）→ 照常弹窗（默认是弹，别写反）", () => {
    expect(isUpdatePromptSuppressed(null)).toBe(false);
    expect(isUpdatePromptSuppressed(undefined)).toBe(false);
    expect(isUpdatePromptSuppressed(0)).toBe(false);
    expect(isUpdatePromptSuppressed(Number.NaN)).toBe(false);
  });

  it("点过「稍后」（任意合法时间戳）→ 自动检查不再弹窗", () => {
    expect(isUpdatePromptSuppressed(1_700_000_000_000)).toBe(true);
    // 用户要的是"再也别跳"，不是"过一会儿再跳"：多久以前点的都一样
    expect(isUpdatePromptSuppressed(Date.now() - 365 * 24 * 3600 * 1000)).toBe(true);
  });

  it("坏值（字符串 / 负数 / Infinity）→ 不静默，宁可多提示一次", () => {
    expect(isUpdatePromptSuppressed("刚刚" as unknown as number)).toBe(false);
    expect(isUpdatePromptSuppressed(-1)).toBe(false);
    expect(isUpdatePromptSuppressed(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("「稍后」后的状态栏提示里写明了「已停止自动提示、可手动检查」", () => {
    expect(UPDATE_DISMISS_NOTICE).toContain("已停止自动提示更新");
    expect(UPDATE_DISMISS_NOTICE).toContain("检查更新");
  });
});

describe("formatBytes", () => {
  it("按 1024 进制、单位随量级变化", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("超过 100 不带小数（更好读）", () => {
    expect(formatBytes(523 * 1024 * 1024)).toBe("523 MB");
  });

  it("非法值 / 非正值一律 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("progressFrom", () => {
  it("正常换算百分比（四舍五入、封顶 100）", () => {
    expect(progressFrom(50, 200).percent).toBe(25);
    expect(progressFrom(199, 200).percent).toBe(100); // 99.5 → 100
    expect(progressFrom(300, 200).percent).toBe(100); // 超出也封顶
    expect(progressFrom(1, 3).percent).toBe(33);
  });

  it("总长未知 → percent 为 null（不能拿 0 冒充，否则进度条永远空着）", () => {
    expect(progressFrom(1024, 0).percent).toBeNull();
    expect(progressFrom(1024, Number.NaN).percent).toBeNull();
    expect(progressFrom(1024, -1).percent).toBeNull();
    expect(formatProgress(progressFrom(1024, 0))).toBe("已下载 1.0 KB");
  });

  it("已下载字节非法 → 归零，不产生 NaN 文案", () => {
    const p = progressFrom(Number.NaN, 1000);
    expect(p.downloaded).toBe(0);
    expect(p.percent).toBe(0);
    expect(formatProgress(p)).not.toContain("NaN");
  });
});

describe("formatProgress", () => {
  it("有总长：百分比 + 已下载/总长", () => {
    expect(formatProgress(progressFrom(1024 * 1024, 4 * 1024 * 1024))).toBe(
      "已下载 25%（1.0 MB / 4.0 MB）",
    );
  });
});

describe("describeUpdateError", () => {
  it("签名校验失败 → 解释 + 原始错误", () => {
    const msg = describeUpdateError(new Error("Signature verification failed"));
    expect(msg).toContain("签名校验失败");
    expect(msg).toContain("Signature verification failed");
  });

  it("清单取不到 / 404 → 指向 latest.json 与草稿态", () => {
    expect(describeUpdateError("Could not fetch a valid release JSON from the remote")).toContain(
      "latest.json",
    );
    expect(describeUpdateError("HTTP 404")).toContain("latest.json");
  });

  it("网络类错误 → 提示检查网络/代理", () => {
    expect(describeUpdateError("error sending request for url (...)")).toContain("网络");
    expect(describeUpdateError("operation timed out")).toContain("网络");
  });

  it("目标平台缺失 → 说明本次发布没带该平台", () => {
    expect(describeUpdateError("target not found: darwin-aarch64")).toContain("本平台");
  });

  it("未知错误原样透出；空错误给\"未知错误\"", () => {
    expect(describeUpdateError("莫名其妙的东西")).toBe("莫名其妙的东西");
    expect(describeUpdateError(null)).toBe("未知错误");
    expect(describeUpdateError("   ")).toBe("未知错误");
  });
});
