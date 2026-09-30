import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { studioSchemas } from "@bb-studio/kit/contract";
import type { Bot } from "../contract";
import { botsSignature, registerStudio, type BotActivity } from "../studio-provider";

const bot = (patch: Partial<Bot> = {}): Bot =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Scout",
    description: "Finds flaky tests.",
    avatar: "🦉",
    providerId: "codex",
    model: "gpt-5",
    handle: "scout",
    home: "/tmp/scout",
    projectId: "proj_scout",
    hostId: "local",
    createdAt: 1,
    updatedAt: 2,
    lastWakeAt: 0,
    error: null,
    ...patch,
  }) as Bot;

function setup(bots: Bot[], activity = new Map<string, BotActivity>()) {
  let handlers: Record<string, (input: unknown) => unknown> = {};
  const bb = { rpc: { register: (_contract: unknown, registered: typeof handlers) => (handlers = registered) } };
  const retired: string[] = [];
  registerStudio(bb as never, studioSchemas(z), {
    bots: () => bots,
    activity: () => activity,
    retire: async (id, value) => void retired.push(`${id}:${value}`),
  });
  const call = async (method: string, input: unknown): Promise<any> => handlers[method]!(input);
  return { call, retired };
}

test("describes bots, which Studio creates through the setup chat", async () => {
  const { call } = setup([]);
  const info = await call("studio_describe", null);
  assert.ok(studioSchemas(z).info.parse(info));
  assert.equal(info.panel, "bots");
  assert.deepEqual(info.kinds[0].create, { mode: "event", event: "bb-studio:bot-teams:new-bot" });
  assert.equal(info.kinds[0].canArchive, true);
});

test("lists bots with their avatar, profile link and state", async () => {
  const scout = bot();
  const broken = bot({ id: "22222222-2222-4222-8222-222222222222", name: "Fixer", error: "Provider missing", retired: true, description: "" });
  const { call } = setup([scout, broken], new Map([[scout.id, { working: true, lastActivityAt: 5 }]]));
  const { items } = await call("studio_list", null);
  assert.ok(studioSchemas(z).provider.studio_list.output.parse({ items }));
  assert.deepEqual(
    items.map((item: any) => [item.title, item.icon, item.href, item.projectId, item.archived, item.badge?.label ?? null, item.preview]),
    [
      ["Scout", "🦉", `/plugins/bot-teams/bots/${scout.id}`, null, false, "Working", "Finds flaky tests."],
      ["Fixer", "🦉", `/plugins/bot-teams/bots/${broken.id}`, null, true, "Error", "@scout"],
    ],
  );
});

test("archives by retiring, and refuses move and delete", async () => {
  const scout = bot();
  const { call, retired } = setup([scout]);
  assert.deepEqual(await call("studio_archive", { ids: [scout.id], archived: true }), { done: [scout.id], failed: [] });
  assert.deepEqual(retired, [`${scout.id}:true`]);
  assert.match((await call("studio_delete", { ids: [scout.id] })).failed[0].error, /Archive them/);
  assert.match((await call("studio_move", { ids: [scout.id], projectId: "proj_a" })).failed[0].error, /own project/);
  assert.deepEqual((await call("studio_search", { query: "@scout" })).ids, [scout.id]);
  assert.deepEqual((await call("studio_search", { query: "@" })).ids, []);
});

test("the change signature ignores activity Studio doesn't show", () => {
  const scout = bot();
  const quiet = botsSignature([scout], new Map([[scout.id, { working: false, lastActivityAt: 1 }]]));
  assert.equal(quiet, botsSignature([scout], new Map([[scout.id, { working: false, lastActivityAt: 9 }]])));
  assert.notEqual(quiet, botsSignature([scout], new Map([[scout.id, { working: true, lastActivityAt: 9 }]])));
  assert.notEqual(quiet, botsSignature([bot({ name: "Scout 2" })], new Map()));
});
