import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { Store } from "../store";
import { Runtime } from "../runtime";
import { permissionSummary } from "../permission-mode";
import { profileInput, type Bot, type Room } from "../contract";

const makeBot = (
  id: string,
  name: string,
  overrides: Partial<Bot> = {},
): Bot => ({
  ...profileInput.parse({ name }),
  id,
  handle: name.toLowerCase(),
  home: `/tmp/${name}`,
  hostId: "host_test",
  projectId: "proj_test",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
  lastWakeAt: Date.now(),
  error: null,
  ...overrides,
});

function setup(modes: string[] = ["accept-edits", "auto", "full"]) {
  let sequence = 0;
  const host = createFakePluginHost({
    pluginId: "bot-teams",
    sdk: {
      providers: {
        // Scribe's provider is the narrower one, so clamping is per bot.
        list: async () => [
          {
            id: "codex",
            available: true,
            capabilities: { permissionModes: modes },
          },
          {
            id: "pi",
            available: true,
            capabilities: {
              permissionModes: modes.filter((m) => m !== "full"),
            },
          },
        ],
      },
      threads: {
        spawn: async () =>
          makeThreadResponse({ id: `thr_bot_${++sequence}`, status: "idle" }),
        send: async () => ({ ok: true, delivery: "sent" }),
        get: async () => makeThreadResponse({ status: "idle" }),
        list: async () => [],
        stop: async () => ({ ok: true }),
        queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
      },
    },
  });
  const store = new Store(host.bb.storage.database());
  const atlas = makeBot("bot_0123456789abcdef", "Atlas");
  const scribe = makeBot("bot_1123456789abcdef", "Scribe", {
    providerId: "pi",
    permissionMode: "accept-edits",
  });
  store.put(atlas);
  store.put(scribe);
  const runtime = new Runtime(host.bb, store);
  const room: Room = {
    id: randomUUID(),
    name: "Research",
    memberIds: [atlas.id, scribe.id],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  };
  store.putRoom(room);
  return {
    ...host,
    store,
    runtime,
    room,
    atlas,
    scribe,
    close: async () => {
      await runtime.dispose();
      await host.harness.lifecycle.dispose();
    },
  };
}

test("without a channel setting every bot keeps its own mode", async () => {
  const x = setup();
  try {
    assert.equal(await x.runtime.permissionMode(x.atlas, x.room.id), "auto");
    assert.equal(
      await x.runtime.permissionMode(x.scribe, x.room.id),
      "accept-edits",
    );
    // Mission work has no channel, so there is nothing to override it.
    assert.equal(await x.runtime.permissionMode(x.atlas, null), "auto");
  } finally {
    await x.close();
  }
});

test("a channel setting overrides every member for work started there", async () => {
  const x = setup();
  try {
    x.store.putRoom({ ...x.room, permissionMode: "accept-edits" });
    assert.equal(
      await x.runtime.permissionMode(x.atlas, x.room.id),
      "accept-edits",
    );
    assert.equal(
      await x.runtime.permissionMode(x.scribe, x.room.id),
      "accept-edits",
    );
    // Mission work runs outside the channel and keeps the bot's own mode.
    assert.equal(await x.runtime.permissionMode(x.atlas, null), "auto");
  } finally {
    await x.close();
  }
});

test("a bot whose provider cannot offer the mode keeps its own", async () => {
  const x = setup();
  try {
    x.store.putRoom({ ...x.room, permissionMode: "full" });
    // Atlas runs on codex, which offers full access; Scribe's provider does not.
    assert.equal(await x.runtime.permissionMode(x.atlas, x.room.id), "full");
    assert.equal(
      await x.runtime.permissionMode(x.scribe, x.room.id),
      "accept-edits",
    );
  } finally {
    await x.close();
  }
});

test("the resolved mode reaches the first spawn and every later turn", async () => {
  const x = setup();
  try {
    x.store.putRoom({ ...x.room, permissionMode: "full" });
    x.runtime.send(
      x.store.room(x.room.id),
      "@atlas Apply the patch",
      randomUUID(),
    );
    await x.runtime.drive(x.atlas);
    const spawn = x.harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0] as {
      permissionMode?: string;
    };
    assert.equal(spawn.permissionMode, "full");
    const first = x.store.work(x.atlas.id)[0]!;
    x.runtime.complete(first.threadId!, "Applied");
    await x.runtime.driveRoom(x.room);

    // The thread already exists, so the mode has to ride the next message.
    x.store.putRoom({ ...x.store.room(x.room.id), permissionMode: "auto" });
    x.runtime.send(x.store.room(x.room.id), "@atlas And again", randomUUID());
    await x.runtime.drive(x.atlas);
    const sent = x.harness.inspection.sdk.callsTo("threads.send").at(-1)?.[0] as {
      permissionMode?: string;
      executionInputSources?: { permissionMode?: string };
    };
    assert.equal(sent.permissionMode, "auto");
    assert.equal(sent.executionInputSources?.permissionMode, "explicit");
  } finally {
    await x.close();
  }
});

test("the footer label reports the channel setting, agreement, or a mix", () => {
  const room: Room = {
    id: randomUUID(),
    name: "Research",
    memberIds: ["bot_0123456789abcdef", "bot_1123456789abcdef"],
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const atlas = makeBot("bot_0123456789abcdef", "Atlas");
  const scribe = makeBot("bot_1123456789abcdef", "Scribe", {
    permissionMode: "accept-edits",
  });
  assert.equal(permissionSummary(room, [atlas, scribe]), "Mixed");
  assert.equal(
    permissionSummary(room, [atlas, { ...scribe, permissionMode: "auto" }]),
    "Auto",
  );
  assert.equal(
    permissionSummary({ ...room, permissionMode: "full" }, [atlas, scribe]),
    "Full Access",
  );
  assert.equal(permissionSummary(room, []), "Each bot's own");
});
