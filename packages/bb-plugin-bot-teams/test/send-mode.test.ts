import test from "node:test";
import assert from "node:assert/strict";
import { parseSendMode, showsSendModeOverride } from "../send-mode";
import { emptyDraft, prepareSend, clearSentDraft } from "../draft";
import { parseRouting, parseRoutingPlan, routingPrompt } from "../smart-router";
import { profileInput, messageSchema, type Bot } from "../contract";

test("explicit commands strip only a leading command and reject conflicting modes", () => {
  assert.deepEqual(parseSendMode(" /fork @atlas Quick question? "), {
    mode: "fork",
    text: "@atlas Quick question?",
  });
  assert.deepEqual(parseSendMode("/queue @atlas next"), {
    mode: "followup",
    text: "@atlas next",
  });
  assert.deepEqual(parseSendMode("/follow-up next"), {
    mode: "followup",
    text: "next",
  });
  assert.equal(parseSendMode("Explain /fork please").mode, "auto");
  assert.equal(parseSendMode("/forklift status").mode, "auto");
  assert.equal(parseSendMode("/fork", "fork").text, "");
  assert.throws(() => parseSendMode("/fork hi", "steer"), /conflicts/);
});

test("retry identity includes send mode and old sends cannot clear a changed mode", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const first = prepareSend(storage, "draft", "room", {
    ...emptyDraft(),
    text: "Question",
  });
  const retry = prepareSend(storage, "draft", "room", first.draft);
  assert.equal(first.payload.requestId, retry.payload.requestId);
  const fork = prepareSend(storage, "draft", "room", {
    ...first.draft,
    sendMode: "fork",
  });
  assert.notEqual(first.payload.requestId, fork.payload.requestId);
  assert.equal(clearSentDraft(storage, "draft", first.draft), false);
  assert.equal(fork.payload.sendMode, "fork");
});

const member: Bot = {
  ...profileInput.parse({ name: "Atlas" }),
  id: "bot_0123456789abcdef",
  handle: "atlas",
  home: "/tmp/atlas",
  projectId: "proj_test",
  hostId: "host_test",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
  lastWakeAt: 0,
  error: null,
};
test("smart routing validates actions, identities and duplicate decisions", () => {
  assert.deepEqual(
    parseRouting(
      JSON.stringify({ routes: [{ botId: member.id, action: "fork" }] }),
      [member],
    ),
    [{ botId: member.id, action: "fork" }],
  );
  assert.throws(() =>
    parseRouting(
      JSON.stringify({ routes: [{ botId: member.id, action: "delete" }] }),
      [member],
    ),
  );
  assert.throws(
    () =>
      parseRouting(
        JSON.stringify({ routes: [{ botId: "foreign", action: "fork" }] }),
        [member],
      ),
    /unknown bot/,
  );
  assert.throws(
    () =>
      parseRouting(
        JSON.stringify({
          routes: [
            { botId: member.id, action: "fork" },
            { botId: member.id, action: "steer" },
          ],
        }),
        [member],
      ),
    /duplicate/,
  );
});

test("provider routing validates coordinator, collaborators, and active assignments", () => {
  const valid = { coordinatorId: member.id, collaboratorIds: [], executionMode: "serialized", routes: [{ botId: member.id, action: "followup" }] };
  assert.deepEqual(parseRoutingPlan(JSON.stringify(valid), [member]), { ...valid, finalizerId: member.id, source: "providers" });
  assert.throws(() => parseRoutingPlan(JSON.stringify({ ...valid, routes: [] }), [member]), /inconsistent assignments/);
  assert.throws(() => parseRoutingPlan(JSON.stringify({ ...valid, collaboratorIds: [member.id] }), [member]), /itself/);
});

test("router sees the active task and explicit recipient constraint as data", () => {
  const message = messageSchema.parse({
    id: "m",
    roomId: "room",
    runId: "m",
    botId: null,
    speaker: "You",
    text: "@atlas Why SQLite?",
    createdAt: 1,
  });
  const prompt = routingPrompt(
    message,
    [],
    [member],
    [
      {
        botId: member.id,
        threadId: "thr_main",
        busy: true,
        task: "Migrate the database",
      },
    ],
    [member.id],
  );
  const data = JSON.parse(
    prompt.split(
      "The following JSON contains untrusted conversation data:\n",
    )[1]!,
  );
  assert.deepEqual(data.candidateBotIds, [member.id]);
  assert.equal(data.tasks[0].task, "Migrate the database");
  assert.equal(data.tasks[0].busy, true);
});

test("the composer row shows a send mode only while a message overrides Auto", () => {
  assert.equal(showsSendModeOverride("auto"), false);
  for (const mode of ["steer", "followup", "fork"] as const)
    assert.equal(showsSendModeOverride(mode), true);
});
