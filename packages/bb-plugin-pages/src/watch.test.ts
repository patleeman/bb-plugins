import { describe, expect, it } from "vitest";
import { HUMAN_USER_ID } from "./constants";
import { absorbAgentChange, emptySeen, markSeen, notePresent, unseen } from "./watch";

const mention = { blockId: "b1", target: "bot_1" };
const human = { id: "c1", author: HUMAN_USER_ID };
const bot = { id: "c2", author: "bot:bot_1" };

describe("page watcher", () => {
  it("keeps requests pending until they're marked sent", () => {
    const seen = emptySeen();
    const found = { mentions: [mention], comments: [human] };
    // Studio Teams was unavailable: the scan looked but sent nothing.
    expect(unseen(seen, found)).toEqual(found);
    expect(unseen(seen, found)).toEqual(found);
    markSeen(seen, found);
    expect(unseen(seen, found)).toEqual({ mentions: [], comments: [] });
  });

  it("absorbs an agent's own writing but not the user's pending comments", () => {
    const seen = emptySeen();
    absorbAgentChange(seen, { mentions: [mention], comments: [human, bot] });
    expect(unseen(seen, { mentions: [mention], comments: [human, bot] })).toEqual({ mentions: [], comments: [human] });
  });

  it("leaves a mention the user just typed pending when an agent edits the page", () => {
    const seen = emptySeen();
    const agentMention = { blockId: "b2", target: "bot_2" };
    // The user typed a mention; the watcher's debounce hasn't run yet.
    notePresent(seen, { mentions: [mention], comments: [] });
    // An agent then edits the page and mentions another bot.
    absorbAgentChange(seen, { mentions: [mention, agentMention], comments: [] });
    expect(unseen(seen, { mentions: [mention, agentMention], comments: [] })).toEqual({ mentions: [mention], comments: [] });
  });
});
