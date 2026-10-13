// 协议来自 typst_world/tests/{paged,cursor,expansion,preview}.rs 的逐行 println!。
const fixtureGroups = [
  { marker: "PAGEFIXTURE:", file: "page-fixtures.json", count: 8, probe: "carets" },
  { marker: "CURSORFIXTURE:", file: "cursor-fixtures.json", count: 9, probe: "cursorQueries" },
  {
    marker: "EXPANSIONFIXTURE:",
    file: "expansion-fixtures.json",
    count: 62,
    probe: "cursorQueries",
  },
  { marker: "PAPERFIXTURE:", file: "preview-paper-fixtures.json", count: 15, probe: "carets" },
  { marker: "ZOOMFIXTURE:", file: "zoom-fixtures.json", count: 37, probe: "carets" },
  {
    marker: "TRANSACTIONFIXTURE:",
    file: "document-transaction-fixtures.json",
    count: 16,
    probe: "carets",
  },
];

/** @param {unknown} value */
function nonemptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

/** @param {string} stdout */
export function inspectPageFixtureOutput(stdout) {
  const lines = stdout.split("\n");
  const groups = fixtureGroups.map((spec) => {
    /** @type {Record<string, unknown>[]} */
    const fixtures = [];
    /** @type {string[]} */
    const names = [];
    /** @type {string[]} */
    const errors = [];
    /** @type {{line: number, prefix: string}[]} */
    const prefixedMarkers = [];
    lines.forEach((line, index) => {
      if (!line.startsWith(spec.marker)) {
        const position = line.indexOf(spec.marker);
        if (
          position > 0 &&
          position < 200 &&
          !fixtureGroups.some((group) => line.startsWith(group.marker))
        ) {
          prefixedMarkers.push({ line: index + 1, prefix: line.slice(0, position) });
        }
        return;
      }
      const label = `${spec.marker} line ${index + 1}`;
      let fixture;
      try {
        fixture = JSON.parse(line.slice(spec.marker.length));
      } catch (error) {
        errors.push(`${label}: invalid JSON: ${String(error)}`);
        return;
      }
      if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
        errors.push(`${label}: fixture must be an object`);
        return;
      }
      fixtures.push(fixture);
      // 整页夹具没有 name；原文摘要和行号仍能定位具体失败产物。
      const name =
        typeof fixture.name === "string" ? fixture.name : String(fixture.doc).slice(0, 120);
      names.push(name);
      const identity = `${label} (${name})`;
      for (const field of ["pages", spec.probe]) {
        if (!nonemptyArray(fixture[field]))
          errors.push(`${identity}: ${field} must be a nonempty array`);
      }
      if (spec.marker === "PAGEFIXTURE:") {
        for (const [doc, diagnostics] of [
          ["brokenDoc", "diagnostics"],
          ["brokenPreviewDoc", "previewDiagnostics"],
        ]) {
          if (fixture[doc] != null && !nonemptyArray(fixture[diagnostics])) {
            errors.push(`${identity}: ${doc} requires nonempty ${diagnostics}`);
          }
        }
      }
    });
    if (fixtures.length !== spec.count) {
      errors.unshift(
        `${spec.marker} expected ${spec.count}, got ${fixtures.length}` +
          (prefixedMarkers.length ? `; prefixed markers: ${JSON.stringify(prefixedMarkers)}` : ""),
      );
    }
    return { ...spec, actualCount: fixtures.length, names, fixtures, prefixedMarkers, errors };
  });
  return { groups, errors: groups.flatMap((group) => group.errors) };
}
