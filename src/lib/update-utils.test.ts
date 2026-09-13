// update-utils 单元测试：自动更新的纯逻辑（节流、进度换算、错误文案、说明裁剪）。
// Tauri 侧的 check/downloadAndInstall 不在这里测（浏览器里没有真实 updater），
// 但"什么时候该检查""进度怎么显示""错误怎么说人话"这些判断全在这里，坏了用户立刻能感觉到。
import { describe, it, expect } from "vitest";
import {
  isCheckDue,
  formatBytes,
  progressFrom,
  formatProgress,
  firstLines,
  describeUpdateError,
  AUTO_CHECK_MIN_INTERVAL_MS,
} from "./update-utils";

describe("isCheckDue", () => {
  const now = 1_700_000_000_000;

  it("从未检查过（null / 0 / 缺字段）→ 该检查", () => {
    expect(isCheckDue(null, now)).toBe(true);
    expect(isCheckDue(undefined, now)).toBe(true);
    expect(isCheckDue(0, now)).toBe(true);
  });

  it("刚检查过（间隔内）→ 不检查", () => {
    expect(isCheckDue(now - 1000, now)).toBe(false);
    expect(isCheckDue(now - AUTO_CHECK_MIN_INTERVAL_MS + 1, now)).toBe(false);
  });

  it("超过间隔 → 该检查（边界值算到期）", () => {
    expect(isCheckDue(now - AUTO_CHECK_MIN_INTERVAL_MS, now)).toBe(true);
    expect(isCheckDue(now - AUTO_CHECK_MIN_INTERVAL_MS * 2, now)).toBe(true);
  });

  it("非法时间戳（NaN）→ 该检查，不当成\"刚查过\"而永久静默", () => {
    expect(isCheckDue(Number.NaN, now)).toBe(true);
  });

  it("时间戳在未来（系统时钟被回拨）→ 该检查", () => {
    expect(isCheckDue(now + 60_000, now)).toBe(true);
  });

  it("间隔可覆盖（测试与将来改策略用）", () => {
    expect(isCheckDue(now - 500, now, 100)).toBe(true);
    expect(isCheckDue(now - 50, now, 100)).toBe(false);
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

describe("firstLines", () => {
  it("行数不超限时原样返回（只去首尾空白）", () => {
    expect(firstLines("  a\nb  ")).toBe("a\nb");
  });

  it("超限时截断并注明省略行数", () => {
    const text = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    const out = firstLines(text, 12);
    expect(out.split("\n")[0]).toBe("第 1 行");
    expect(out).toContain("已省略后续 8 行");
    expect(out).not.toContain("第 13 行");
  });

  it("CRLF 也按行处理", () => {
    expect(firstLines("a\r\nb\r\nc", 2)).toContain("已省略后续 1 行");
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
