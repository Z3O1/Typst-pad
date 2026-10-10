import { describe, expect, it } from "vitest";
import { fakePages } from "./fake-layout";

describe("fakePages explicit paper regression seam", () => {
  it("distinguishes natural paper edits from preview overrides", () => {
    const large = "#set page(width: 480pt, height: 640pt, margin: 20pt)\n单页";
    const small = large.replace("480pt, height: 640pt", "240pt, height: 320pt");
    expect(fakePages(large)[0]).toContain('viewBox="0 0 480 640"');
    expect(fakePages(small)[0]).toContain('viewBox="0 0 240 320"');
    expect(fakePages(small, { widthPt: 314.29, heightPt: 419.05, marginPt: 46.4 })[0]).toContain(
      'viewBox="0 0 314.29 419.05"',
    );
  });

  it("takes the last explicit rule after prefix and otherwise retains A4", () => {
    const prefix = "#set page(width: 480pt, height: 640pt, margin: 20pt)\n";
    expect(
      fakePages(prefix + "#set page(width: 240pt, height: 320pt, margin: 20pt)\n正文")[0],
    ).toContain('viewBox="0 0 240 320"');
    expect(fakePages("正文")[0]).toContain('viewBox="0 0 595.28 841.89"');
  });
});
