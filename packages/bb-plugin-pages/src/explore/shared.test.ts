import { describe, expect, it } from "vitest";
import { DEFAULT_EMOJI, MAX_ITEMS, MAX_LABEL_LENGTH, formatExploreItems, parseExploreItems } from "./shared";

describe("parsing ::explore items", () => {
  it("splits on |, taking the emoji off the label", () => {
    expect(parseExploreItems("🐛 Retry backoff disagrees in billing|🏗️ How the job queue works")).toEqual([
      { emoji: "🐛", label: "Retry backoff disagrees in billing" },
      { emoji: "🏗️", label: "How the job queue works" },
    ]);
  });

  it("takes the emoji off a label written without a space", () => {
    expect(parseExploreItems("🐛Retry backoff|👩‍💻 Who reviews")).toEqual([
      { emoji: "🐛", label: "Retry backoff" },
      { emoji: "👩‍💻", label: "Who reviews" },
    ]);
  });

  it("gives an item without an emoji the default one", () => {
    expect(parseExploreItems("How the job queue works")).toEqual([{ emoji: DEFAULT_EMOJI, label: "How the job queue works" }]);
  });

  it("drops empty and emoji-only items, and collapses whitespace", () => {
    expect(parseExploreItems(" | 🐛 |🔗   Where   retries\nare scheduled ||")).toEqual([{ emoji: "🔗", label: "Where retries are scheduled" }]);
  });

  it("dedupes labels regardless of case, spacing or emoji", () => {
    expect(parseExploreItems("🐛 Cache keys ignore tenant|🔗 cache keys  ignore TENANT|🕐 Recent auth change")).toEqual([
      { emoji: "🐛", label: "Cache keys ignore tenant" },
      { emoji: "🕐", label: "Recent auth change" },
    ]);
  });

  it(`keeps at most ${MAX_ITEMS} items`, () => {
    const raw = Array.from({ length: 9 }, (_, index) => `🔗 Finding ${index}`).join("|");
    expect(parseExploreItems(raw)).toHaveLength(MAX_ITEMS);
    expect(parseExploreItems(raw, 3)).toHaveLength(3);
  });

  it("cuts long labels at a word", () => {
    const [item] = parseExploreItems(`🏗️ ${"word ".repeat(40)}`);
    expect(item!.label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(item!.label.endsWith("…")).toBe(true);
    expect(item!.label).not.toMatch(/wor…$/);
  });

  it("strips characters that would break attributes or markup", () => {
    expect(parseExploreItems('🐛 The "retry" {loop}')).toEqual([{ emoji: "🐛", label: "The retry loop" }]);
  });

  it("handles missing and non-string input", () => {
    expect(parseExploreItems(undefined)).toEqual([]);
    expect(parseExploreItems(null)).toEqual([]);
    expect(parseExploreItems("")).toEqual([]);
  });

  it("round-trips through the attribute form", () => {
    const items = parseExploreItems("🐛 A thing|🏗️ Another thing");
    expect(parseExploreItems(formatExploreItems(items))).toEqual(items);
  });
});
