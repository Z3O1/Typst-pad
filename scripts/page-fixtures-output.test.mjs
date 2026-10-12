import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPageFixtureOutput } from "./page-fixtures-output.mjs";
const samples = JSON.parse(
  readFileSync(new URL("./page-fixtures-output.samples.json", import.meta.url), "utf8"),
);

// 每组最短的一条原始 println!，逐字取自本轮真实 Cargo 导出（没有替换 SVG/探针）。
// 重复样本只构造数量边界，不把此输入冒充完整的原生导出。
const counts = [8, 9, 33, 15, 37, 16];
const lines = samples.flatMap((sample, index) => Array(counts[index]).fill(sample));
const validOutput = lines.join("\n");

function changeSample(index, change) {
  const sample = samples[index];
  const markerEnd = sample.indexOf(":") + 1;
  const fixture = JSON.parse(sample.slice(markerEnd));
  const changed = [...lines];
  changed[lines.indexOf(sample)] = sample.slice(0, markerEnd) + JSON.stringify(change(fixture));
  return changed.join("\n");
}

describe("page-fixtures native stdout protocol", () => {
  it("accepts verbatim native SVG/probes with all six strict counts and libtest noise", () => {
    const report = inspectPageFixtureOutput(
      `running 5 tests\r\n${validOutput.replaceAll("\n", "\r\n")}\r\ntest result: ok. 5 passed\r\n`,
    );
    expect(report.errors).toEqual([]);
    expect(report.groups.map((group) => group.actualCount)).toEqual(counts);
    expect(report.groups[1].fixtures[0]).toEqual(
      JSON.parse(samples[1].slice("CURSORFIXTURE:".length)),
    );
    expect(report.groups[5].file).toBe("document-transaction-fixtures.json");
    expect(report.groups[5].fixtures[0]).toEqual(
      JSON.parse(samples[5].slice("TRANSACTIONFIXTURE:".length)),
    );
  });

  it.each([0, 1, 2, 3, 4, 5])("rejects a missing or extra native record in group %i", (index) => {
    const fewer = [...lines];
    fewer.splice(lines.indexOf(samples[index]), 1);
    expect(inspectPageFixtureOutput(fewer.join("\n")).errors).toContain(
      `${samples[index].split(":")[0]}: expected ${counts[index]}, got ${counts[index] - 1}`,
    );
    expect(inspectPageFixtureOutput(`${validOutput}\n${samples[index]}`).errors).toContain(
      `${samples[index].split(":")[0]}: expected ${counts[index]}, got ${counts[index] + 1}`,
    );
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "identifies native names/source and empty or missing fields in group %i",
    (index) => {
      const probe = index === 1 || index === 2 ? "cursorQueries" : "carets";
      for (const field of ["pages", probe]) {
        for (const value of [[], null, {}, undefined]) {
          const report = inspectPageFixtureOutput(
            changeSample(index, (fixture) => ({ ...fixture, [field]: value })),
          );
          expect(report.errors).toHaveLength(1);
          expect(report.errors[0]).toContain(`${field} must be a nonempty array`);
          expect(report.errors[0]).toMatch(/line \d+ \(.+\)/s);
        }
      }
    },
  );

  it.each([
    ["brokenDoc", "diagnostics"],
    ["brokenPreviewDoc", "previewDiagnostics"],
  ])("requires native diagnostics for %s", (doc, diagnostics) => {
    const report = inspectPageFixtureOutput(
      changeSample(0, (fixture) => ({ ...fixture, [doc]: fixture.doc, [diagnostics]: [] })),
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(`${doc} requires nonempty ${diagnostics}`);
  });

  it("retains an unsupported prefixed marker as evidence without silently accepting it", () => {
    const altered = [...lines];
    const index = lines.indexOf(samples[2]);
    altered[index] =
      `test typst_world::tests::expansion::dump_page_fixtures_expansion ... ${samples[2]}`;
    const report = inspectPageFixtureOutput(altered.join("\n"));
    expect(report.groups[2].actualCount).toBe(32);
    expect(report.groups[2].prefixedMarkers).toEqual([
      {
        line: index + 1,
        prefix: "test typst_world::tests::expansion::dump_page_fixtures_expansion ... ",
      },
    ]);
    expect(report.errors[0]).toContain("EXPANSIONFIXTURE: expected 33, got 32; prefixed markers:");
  });

  it("reports truncated native JSON and non-object records rather than dropping them", () => {
    const malformed = [...lines];
    malformed[0] = samples[0].slice(0, -1);
    expect(
      inspectPageFixtureOutput(malformed.join("\n")).errors.some((error) =>
        error.includes("PAGEFIXTURE: line 1: invalid JSON"),
      ),
    ).toBe(true);
    expect(inspectPageFixtureOutput(changeSample(0, () => null)).errors).toContain(
      "PAGEFIXTURE: line 1: fixture must be an object",
    );
  });

  it("fails every count on empty stdout", () => {
    expect(
      inspectPageFixtureOutput("").groups.every(
        (group) => group.actualCount === 0 && group.errors.length === 1,
      ),
    ).toBe(true);
  });

  it("retains command/raw/count evidence and writes no consumable fixtures when Cargo cannot start", () => {
    const cwd = mkdtempSync(join(tmpdir(), "page-fixtures-startup-"));
    try {
      const script = fileURLToPath(new URL("./page-fixtures.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [script], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: "" },
      });
      expect(result.status).toBe(1);
      const out = join(cwd, ".browser-check");
      expect(readdirSync(out)).toEqual(["page-fixtures-exports"]);
      const exportsDir = join(out, "page-fixtures-exports");
      const attempt = join(exportsDir, readdirSync(exportsDir)[0]);
      const command = JSON.parse(readFileSync(join(attempt, "command.json"), "utf8"));
      expect(command.status).toBeNull();
      expect(command.error).toContain("ENOENT");
      expect(readFileSync(join(attempt, "stdout.log"), "utf8")).toBe("");
      expect(readFileSync(join(attempt, "stderr.log"), "utf8")).toBe("");
      expect(
        JSON.parse(readFileSync(join(attempt, "counts.json"), "utf8")).map(
          (group) => group.actualCount,
        ),
      ).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });
});
