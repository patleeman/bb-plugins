import test from "node:test";
import assert from "node:assert/strict";
import {
  channelSlug,
  linkChannelReferences,
  matchingChannels,
} from "../channel-references";
import type { Room } from "../contract";

const room = (id: string, name: string, archived = false): Room => ({
  id,
  name,
  memberIds: [],
  archived,
  paused: false,
  createdAt: 1,
  updatedAt: 1,
});

test("channel references link known slugs and preserve unknown text", () => {
  const rooms = [room("11111111-1111-4111-8111-111111111111", "Design Notes")];
  assert.equal(
    linkChannelReferences(
      "See #design-notes and #missing, but keep `#design-notes` as code.",
      rooms,
    ),
    "See [#Design Notes](/plugins/bots/channels/11111111-1111-4111-8111-111111111111) and #missing, but keep `#design-notes` as code.",
  );
});

test("channel picker excludes the current and archived channels", () => {
  const current = room("11111111-1111-4111-8111-111111111111", "Design Notes");
  const rooms = [
    current,
    room("22222222-2222-4222-8222-222222222222", "Design Review"),
    room("33333333-3333-4333-8333-333333333333", "Archived Design", true),
  ];
  assert.equal(channelSlug("Design Review"), "design-review");
  assert.deepEqual(matchingChannels(rooms, current.id, "design"), [rooms[1]]);
});

test("selected references retain channel identity across rename and slug collisions", async () => {
  const { channelReference } = await import("../channel-references");
  const a = room("11111111-1111-4111-8111-111111111111", "Design Notes"),
    b = room("22222222-2222-4222-8222-222222222222", "Design-Notes");
  const selected = channelReference(a);
  assert.equal(
    linkChannelReferences(selected, [{ ...a, name: "Decisions" }, b]),
    selected,
  );
  assert.equal(linkChannelReferences("#design-notes", [a, b]), "#design-notes");
});

test("references preserve links, URL fragments, escaped mentions and all Markdown code forms", () => {
  const rooms = [room("11111111-1111-4111-8111-111111111111", "Design Notes")];
  for (const text of [
    "[notes](https://example.com/#design-notes)",
    "https://example.com/#design-notes",
    "<https://example.com/#design-notes>",
    "\\#design-notes",
    "`` #design-notes ` ``",
    "~~~\n#design-notes\n~~~",
    "    #design-notes\n",
    "[see #design-notes](https://example.com)",
  ]) {
    assert.equal(linkChannelReferences(text, rooms), text);
  }
});
