import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotClient, codexAuth, dotHealth, isDotReply, type DotRoom } from "./dot-client.js";
const room: DotRoom = { agentId: "dot-1", roomId: "room-1", rootId: "root-1", memberId: "dot-member", paused: false };
const auth = () => ({ read: vi.fn(async () => ({ access_token: "fake-token", account_id: "fake-account" })), refresh: vi.fn(async () => {}) });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
it("correlates only the Dot member's request or direct reply, ignoring unrelated and deleted messages", () => {
  const message = { id: "reply", account_user_id: "dot-member", content: { text: "ok" }, reply_to: { message_id: "submitted" } };
  expect(isDotReply(message, room, "request", "submitted")).toBe(true);
  expect(isDotReply({ ...message, reply_to: null, request_id: "request" }, room, "request", "submitted")).toBe(true);
  expect(isDotReply({ ...message, account_user_id: "other-agent" }, room, "request", "submitted")).toBe(false);
  expect(isDotReply({ ...message, reply_to: null }, room, "request", "submitted")).toBe(false);
  expect(isDotReply({ ...message, deleted_at: "now" }, room, "request", "submitted")).toBe(false);
  expect(isDotReply({ ...message, reply_to: { message_id: "other-request" } }, room, "request", "submitted")).toBe(false);
});
it("rereads rotated credentials from disk and sanitizes invalid auth errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bb-dot-auth-"));
  try {
    const source = codexAuth(directory);
    for (const token of ["first", "rotated"]) {
      await writeFile(join(directory, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "account" } }));
      expect((await source.read()).access_token).toBe(token);
    }
    await writeFile(join(directory, "auth.json"), "secret-but-invalid");
    await expect(source.read()).rejects.toThrow("existing Codex ChatGPT sign-in");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("refreshes once on 401 and retries the same idempotent submission", async () => {
  const source = auth();
  source.refresh.mockImplementation(async () => { source.read.mockResolvedValue({ access_token: "rotated", account_id: "fake-account" }); });
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ id: "submitted", content: { text: "hello" } }));
  await new DotClient(source, request).submit(room, "hello", "unique-request");
  expect(source.refresh).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![1]?.body).toBe(request.mock.calls[1]![1]?.body);
  expect(request.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: "Bearer rotated" });
  expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({ request_id: "unique-request", idempotency_token: "unique-request" });
});
it("reuses an externally rotated token without refreshing again", async () => {
  const source = auth(); source.read.mockResolvedValueOnce({ access_token: "old", account_id: "account" }).mockResolvedValue({ access_token: "new", account_id: "account" });
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}));
  await new DotClient(source, request).http("/tbo/primary");
  expect(source.refresh).not.toHaveBeenCalled();
  expect(request.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: "Bearer new" });
});
it("sanitizes response bodies and network errors", async () => {
  const client = new DotClient(auth(), vi.fn<typeof fetch>().mockResolvedValue(json({ secret: "must-not-leak" }, 403)));
  await expect(client.http("/tbo/primary")).rejects.toThrow("Dot API rejected the request (HTTP 403).");
  const offline = new DotClient(auth(), vi.fn<typeof fetch>().mockRejectedValue(new Error("Bearer must-not-leak")));
  expect(await dotHealth(offline)).toEqual({ online: false, status: "unknown", message: "Dot is unreachable. Check this host's network connection." });
});
it("verifies selected Dot membership and reports paused without submitting", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(json({ selection: { thread_id: "initial-root", available: true } }))
    .mockResolvedValueOnce(json({ id: "dot-1", messaging_room_id: "room-1", active_root_thread_id: "new-root", is_paused: true }))
    .mockResolvedValueOnce(json({ id: "room-1", aeon_id: "dot-1", members: [{ account_user_id: "person" }, { account_user_id: "dot-member", aeon_id: "dot-1" }] }));
  const client = new DotClient(auth(), request);
  expect(await dotHealth(client)).toMatchObject({ online: true, status: "paused" });
  expect(request.mock.calls[1]![0]).toBe("https://chatgpt.com/backend-api/tbo/by-thread/initial-root");
  await expect(client.submit({ ...room, paused: true }, "hello", "request")).rejects.toThrow("Dot is paused");
  expect(request).toHaveBeenCalledTimes(3);
});
it.runIf(process.env.BB_DOT_LIVE_READONLY === "1")("verifies live Dot discovery without sending a message", async () => {
  const result = await dotHealth();
  expect(result.online, result.message).toBe(true);
  expect(["ready", "paused"]).toContain(result.status);
}, 60_000);
