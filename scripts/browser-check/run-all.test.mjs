import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Inspect source without importing run-all, which would launch processes.
const source = readFileSync(new URL("./run-all.mjs", import.meta.url), "utf8");
const suites = JSON.parse(
  source.match(/const SUITES = (\[[\s\S]*?\n\]);/)[1].replace(/,\s*]/g, "]"),
);
const fixtures = JSON.parse(
  source.match(/const SUITE_FIXTURES = ({[\s\S]*?\n});/)[1].replace(/,\s*}/g, "}"),
);

// 真实产物/交互覆盖变化时，套件、计数与夹具依赖一起更新。
const expectedSuites = [
  ["document-mode.mjs", 81],
  ["document-cursor.mjs", 37],
  ["document-expansion.mjs", 114],
  ["empty-formula.mjs", 39],
  ["document-transaction.mjs", 6],
  ["document-performance.mjs", 6],
  ["computed-style.mjs", 18],
  ["preview-reflow.mjs", 28],
  ["zoom-stability.mjs", 38],
  ["source-workflows.mjs", 59],
  ["dollar-completion.mjs", 32],
  ["document-completion.mjs", 21],
  ["editor-shortcuts.mjs", 22],
  ["file-changes.mjs", 31],
  ["source-scroll-sync.mjs", 22],
];

describe("browser-check/run-all headless launch", () => {
  it.each([
    "/cache/chromium/chrome-linux64/chrome",
    "/cache/chromium_headless_shell/chrome-headless-shell-linux64/chrome-headless-shell",
  ])("explicitly launches %s without a visible browser window", (chrome) => {
    // 执行实际启动调用，但截获 launch；不导入会启动进程的运行器。
    const launchSource = source.match(/  launch\("chrome", chrome, \[[\s\S]*?\n  \]\);/)[0];
    const calls = [];
    runInNewContext(launchSource, {
      launch: (...args) => calls.push(args),
      chrome,
      join,
      OUT: "/worktree/.browser-check",
      cdpPort: "19464",
      APP_URL: "http://127.0.0.1:15464/?browserdev=1",
    });
    expect(calls).toHaveLength(1);
    const [label, executable, args] = calls[0];
    expect([label, executable]).toEqual(["chrome", chrome]);
    expect(args.filter((arg) => arg.startsWith("--headless"))).toEqual(["--headless=new"]);
    expect(args).toContain("--password-store=basic");
    expect(args).toContain("--user-data-dir=/worktree/.browser-check/cdp-profile-run-all-19464");
    expect(args).toContain("--remote-debugging-port=19464");
  });
});

describe("browser-check/run-all registration", () => {
  it("runs all fifteen suites with their exact assertion counts", () => {
    expect(suites).toEqual(expectedSuites);
    for (const [file] of suites) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("retains real page export dependencies and registers fixture-free additions", () => {
    expect(Object.keys(fixtures)).toEqual(suites.map(([file]) => file));
    const fixtureFree = new Set([
      "computed-style.mjs",
      "source-workflows.mjs",
      "dollar-completion.mjs",
      "editor-shortcuts.mjs",
      "file-changes.mjs",
    ]);
    for (const [file] of suites) {
      expect(fixtures[file]).toEqual(
        file === "source-scroll-sync.mjs" ? ["scroll"] : fixtureFree.has(file) ? [] : ["pages"],
      );
    }
    expect(source).toContain('scroll: ["fixtures-scroll", ["run", "fixtures:scroll"]]');
    expect(source).toContain("for (const name of Object.keys(FIXTURE_STEPS))");
  });
});
