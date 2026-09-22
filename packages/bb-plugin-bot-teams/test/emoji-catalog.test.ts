import test from "node:test";
import assert from "node:assert/strict";
import { emojiSchema } from "../contract";
import { emojiCatalog } from "../emoji-catalog";

test("the complete picker catalog and skin tone variants are accepted as reactions", () => {
  const entries = Object.values(emojiCatalog.emojis).flat();
  assert.ok(
    entries.length > 1800,
    "Use the full catalog, not a curated subset",
  );
  for (const entry of entries) {
    for (const unified of [entry.u, ...(entry.v ?? [])]) {
      const emoji = String.fromCodePoint(
        ...unified.split("-").map((part) => parseInt(part, 16)),
      );
      assert.ok(
        emojiSchema.safeParse(emoji).success,
        `Rejected ${unified}: ${emoji}`,
      );
    }
  }
});

test("emoji search matches capitalized country names and pasted variants", () => {
  const entries = Object.values(emojiCatalog.emojis).flat();
  const matches = (query: string) =>
    entries
      .filter((emoji) =>
        emoji.n.some((name) => name.includes(query.toLowerCase())),
      )
      .map((emoji) => emoji.u);
  assert.ok(matches("Canada").includes("1f1e8-1f1e6"));
  assert.ok(matches("NEW ZEALAND").includes("1f1f3-1f1ff"));
  assert.ok(matches("🦦").includes("1f9a6"));
  assert.ok(matches("👍🏽").includes("1f44d"));
});
