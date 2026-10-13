import { describe, expect, it } from "vitest";
import { inspectSourceScrollFixtureOutput } from "./source-scroll-fixtures-output.mjs";

const fixture = {
  doc: "中文 😀",
  pages: ["svg"],
  carets: [{}],
  cursorQueries: [{}],
  whitespaceHits: [{}],
};
const record = (value) => `SCROLLFIXTURE:${JSON.stringify(value)}`;
describe("source-scroll-fixtures native export gate", () => {
  it("accepts exactly one fixture with all native probe arrays", () => {
    const result = inspectSourceScrollFixtureOutput(`noise\n${record(fixture)}\r\n`);
    expect(result.errors).toEqual([]);
    expect(result.groups[0].fixtures).toEqual([fixture]);
  });
  it.each(["pages", "carets", "cursorQueries", "whitespaceHits", "doc"])(
    "rejects missing %s",
    (field) => {
      expect(
        inspectSourceScrollFixtureOutput(record({ ...fixture, [field]: undefined })).errors.join(),
      ).toContain(`missing ${field === "doc" ? "source" : field}`);
    },
  );
  it("rejects empty, extra, malformed, and prefixed records", () => {
    for (const stdout of [
      "",
      record(fixture) + "\n" + record(fixture),
      "SCROLLFIXTURE:{",
      "noise " + record(fixture),
    ])
      expect(inspectSourceScrollFixtureOutput(stdout).errors.length).toBeGreaterThan(0);
  });
});
