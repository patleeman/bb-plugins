import data from "emoji-picker-react/dist/data/emojis-en";

// The picker lowercases queries but compares them against names verbatim.
// Retain display names while adding searchable aliases for capitalized names
// (especially country flags) and pasted emoji, including skin tone variants.
export const emojiCatalog: typeof data = {
  ...data,
  emojis: Object.fromEntries(
    Object.entries(data.emojis).map(([category, emojis]) => [
      category,
      emojis.map((emoji) => {
        const names = new Set([
          ...emoji.n.map((name) => name.toLowerCase()),
          ...[emoji.u, ...(emoji.v ?? [])].map((unified) =>
            String.fromCodePoint(
              ...unified.split("-").map((part) => parseInt(part, 16)),
            ),
          ),
          ...emoji.n,
        ]);
        // The picker uses the last name as the accessible/preview label.
        const label = emoji.n.at(-1);
        if (label) {
          names.delete(label);
          names.add(label);
        }
        return { ...emoji, n: [...names] };
      }),
    ]),
  ),
};
