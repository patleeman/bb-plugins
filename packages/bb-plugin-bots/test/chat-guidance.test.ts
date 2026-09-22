import test from "node:test";
import assert from "node:assert/strict";
import { chatGuidance } from "../chat-guidance";

test("channel bot guidance makes Markdown output scannable", () => {
  assert.match(
    chatGuidance,
    /Use Markdown when it makes the answer easier to scan/,
  );
  assert.match(chatGuidance, /bullets for three or more related items/);
  assert.match(chatGuidance, /numbered lists for sequences/);
  assert.match(chatGuidance, /fenced code blocks for commands or snippets/);
  assert.match(chatGuidance, /Avoid dense walls of text/);
});
