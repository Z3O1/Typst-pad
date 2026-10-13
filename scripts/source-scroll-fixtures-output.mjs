export function inspectSourceScrollFixtureOutput(stdout) {
  const marker = "SCROLLFIXTURE:";
  const fixtures = [];
  const errors = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (!line.startsWith(marker)) continue;
    try {
      const fixture = JSON.parse(line.slice(marker.length));
      fixtures.push(fixture);
      for (const field of ["pages", "carets", "cursorQueries", "whitespaceHits"]) {
        if (!Array.isArray(fixture[field]) || fixture[field].length === 0)
          errors.push(`${marker} line ${index + 1}: missing ${field}`);
      }
      if (typeof fixture.doc !== "string" || !fixture.doc.length)
        errors.push(`${marker} line ${index + 1}: missing source`);
    } catch (error) {
      errors.push(`${marker} line ${index + 1}: invalid JSON: ${error}`);
    }
  }
  if (fixtures.length !== 1) errors.push(`${marker} expected 1, got ${fixtures.length}`);
  return {
    errors,
    groups: [
      {
        marker,
        file: "source-scroll-fixtures.json",
        count: 1,
        actualCount: fixtures.length,
        names: ["dense-multipage-scroll"],
        errors,
        fixtures,
      },
    ],
  };
}
