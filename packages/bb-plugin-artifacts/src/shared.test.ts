import { describe, expect, it } from "vitest";
import { TYPE_LABELS, prunePicked, titleFromName } from "./shared";

describe("titleFromName", () => {
  it("makes a readable, capitalised title from a file name", () => {
    expect(titleFromName("reports/q3-usage_report.html")).toBe("Q3 usage report");
    expect(titleFromName("release notes.md")).toBe("Release notes");
    expect(titleFromName(".env")).toBe(".env");
  });
});

describe("TYPE_LABELS", () => {
  it("are words, not icon names", () => {
    for (const label of Object.values(TYPE_LABELS)) expect(label).toMatch(/^[A-Z][A-Za-z]*$/);
  });
});

describe("prunePicked", () => {
  const file = (path: string, artifactId: string | null = null) => ({ path, artifactId });

  it("ticks the reply's unsaved files on the first load", () => {
    expect([...prunePicked(null, { reply: [file("/a"), file("/b", "art_1")], storage: [file("/c")] })]).toEqual(["/a"]);
  });

  it("drops paths the reloaded list no longer offers", () => {
    expect([...prunePicked(new Set(["/a", "/c", "/gone"]), { reply: [file("/a")], storage: [file("/c")] })]).toEqual(["/a", "/c"]);
  });
});
