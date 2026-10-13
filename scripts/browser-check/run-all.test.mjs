import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read only the declarative registry: importing run-all would launch processes.
const source = readFileSync(new URL("./run-all.mjs", import.meta.url), "utf8");
const suites = JSON.parse(
  source.match(/const SUITES = (\[[\s\S]*?\n\]);/)[1].replace(/,\s*]/g, "]"),
);
const fixtures = JSON.parse(
  source.match(/const SUITE_FIXTURES = ({[\s\S]*?\n});/)[1].replace(/,\s*}/g, "}"),
);

// Preserve the existing suites and counts when registering new fixture-free suites.
const expectedSuites = [
  ["document-mode.mjs", 81],
  ["document-cursor.mjs", 36],
  ["document-expansion.mjs", 89],
  ["document-transaction.mjs", 6],
  ["document-performance.mjs", 6],
  ["computed-style.mjs", 18],
  ["preview-reflow.mjs", 25],
  ["zoom-stability.mjs", 38],
  ["source-workflows.mjs", 59],
  ["dollar-completion.mjs", 32],
  ["document-completion.mjs", 21],
  ["editor-shortcuts.mjs", 22],
  ["file-changes.mjs", 31],
  ["source-scroll-sync.mjs", 22],
];

describe("browser-check/run-all registration", () => {
  it("runs all fourteen suites with their exact assertion counts", () => {
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
