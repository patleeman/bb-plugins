import test from "node:test";
import assert from "node:assert/strict";
import { directMessagesInTurn, managedPromptInTurn } from "../direct-messages";

const events = [
  {
    type: "turn/completed",
    scope: { kind: "turn", turnId: "turn-2" },
    createdAt: 60,
    data: {},
  },
  {
    type: "turn/input/accepted",
    scope: { kind: "turn", turnId: "turn-2" },
    createdAt: 50,
    data: { clientRequestId: "dm-2" },
  },
  {
    type: "client/turn/requested",
    scope: { kind: "thread" },
    createdAt: 40,
    data: {
      requestId: "dm-2",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "Private follow-up" }],
    },
  },
  {
    type: "turn/input/accepted",
    scope: { kind: "turn", turnId: "turn-2" },
    createdAt: 30,
    data: { clientRequestId: "job-2" },
  },
  {
    type: "client/turn/requested",
    scope: { kind: "thread" },
    createdAt: 20,
    data: {
      requestId: "job-2",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "Managed job prompt" }],
    },
  },
  {
    type: "client/turn/requested",
    scope: { kind: "thread" },
    createdAt: 10,
    data: {
      requestId: "queued-dm",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "Queued for the next turn" }],
    },
  },
];

test("channel tombstones use accepted direct inputs from the same turn", () => {
  assert.deepEqual(directMessagesInTurn(events, "completed", ["Managed job prompt"]), [
    { requestId: "dm-2", createdAt: 40 },
  ]);
  assert.equal(managedPromptInTurn(events, "completed", ["Managed job prompt"]), true);
  assert.deepEqual(directMessagesInTurn(events, "active"), []);
});
