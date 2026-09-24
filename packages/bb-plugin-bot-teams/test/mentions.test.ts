import test from "node:test";
import assert from "node:assert/strict";
import { mentionsEveryone, matchingBroadcastMentions, mentioned } from "../mentions";

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

import { linkifyMentions, mentionBotId, mentionHref } from "../mentions";

const known: Record<string, string> = {
  "spool-expert": "bot_1111111111111111",
  red4: "bot_2222222222222222",
};
const resolve = (handle: string) => known[handle.toLowerCase()] ?? null;
const link = (handle: string) =>
  `[@${handle}](${mentionHref(known[handle]!)})`;

test("known handles become links and unknown ones stay text", () => {
  assert.equal(
    linkifyMentions("@red4 please brief @nobody", resolve),
    `${link("red4")} please brief @nobody`,
  );
});

test("a mention keeps the punctuation around it", () => {
  assert.equal(
    linkifyMentions("(@red4: ping)", resolve),
    `(${link("red4")}: ping)`,
  );
});

// A chip must mean the bot was actually notified, so linkifying follows the
// same handle boundary as mentioned(): a trailing . - or _ breaks both.
test("a handle that would not notify the bot is not chipped", () => {
  for (const text of ["ask @red4.", "@red4-guide", "@red4_guide"]) {
    assert.equal(linkifyMentions(text, resolve), text);
    assert.equal(mentioned(text, "red4"), false, text);
  }
});

test("an address is not a mention", () => {
  assert.equal(linkifyMentions("mail@red4.com", resolve), "mail@red4.com");
});

test("code and existing links are left alone", () => {
  for (const text of [
    "`@red4` is a handle",
    "```\n@red4 stays literal\n```",
    "[@red4](https://example.test/red4)",
  ])
    assert.equal(linkifyMentions(text, resolve), text);
});

test("an unterminated fence does not linkify the rest of the message", () => {
  assert.equal(
    linkifyMentions("```\n@red4 unterminated", resolve),
    "```\n@red4 unterminated",
  );
});

test("mention hrefs round-trip the bot id", () => {
  assert.equal(mentionBotId(mentionHref("bot_2222222222222222")), "bot_2222222222222222");
  assert.equal(mentionBotId("/plugins/bot-teams/channels/abc"), null);
});
