import test from "node:test";
import assert from "node:assert/strict";
import { mentionsEveryone, matchingBroadcastMentions } from "../mentions";

test("broadcast mentions match complete, case-insensitive handles", () => {
  for (const handle of ["all", "channel", "everyone"]) {
    assert.equal(
      mentionsEveryone(`(@${handle.toUpperCase()}), review this`),
      true,
    );
    for (const text of [
      `mail@${handle}.com`,
      `@${handle}-guide`,
      `@${handle}_guide`,
      `@${handle}2`,
    ])
      assert.equal(mentionsEveryone(text), false, text);
  }
});

test("broadcast completion offers all and channel, and resolves the everyone alias", () => {
  assert.deepEqual(matchingBroadcastMentions(""), [
    { handle: "all" },
    { handle: "channel" },
  ]);
  assert.deepEqual(matchingBroadcastMentions("CH"), [{ handle: "channel" }]);
  assert.deepEqual(matchingBroadcastMentions("all"), [{ handle: "all" }]);
  assert.deepEqual(matchingBroadcastMentions("every"), [{ handle: "everyone" }]);
  assert.deepEqual(matchingBroadcastMentions("atlas"), []);
});
