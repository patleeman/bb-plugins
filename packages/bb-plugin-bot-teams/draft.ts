import type { Attachment, RoomMessage } from "./contract";
import {
  channelHandoffMessage,
  parseLegacyChannelHandoffDraft,
  type ChannelHandoffSource,
} from "./handoff-draft";
import { parseSendMode, sendModes, type SendMode } from "./send-mode";

export type Draft = {
  text: string;
  attachments: Attachment[];
  reply: RoomMessage | null;
  request: { fingerprint: string; id: string } | null;
  sendMode: SendMode;
  handoffSource: ChannelHandoffSource | null;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export const emptyDraft = (): Draft => ({
  text: "",
  attachments: [],
  reply: null,
  request: null,
  sendMode: "auto",
  handoffSource: null,
});
export function readDraft(storage: Storage, key: string): Draft {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (
      value &&
      typeof value.text === "string" &&
      Array.isArray(value.attachments)
    ) {
      const legacy = !value.request && !value.handoffSource
        ? parseLegacyChannelHandoffDraft(value.text)
        : null;
      const storedSource =
        value.handoffSource &&
        typeof value.handoffSource.threadId === "string" &&
        typeof value.handoffSource.projectId === "string" &&
        typeof value.handoffSource.title === "string"
          ? value.handoffSource
          : null;
      return {
        ...emptyDraft(),
        ...value,
        text: legacy?.text ?? value.text,
        sendMode: sendModes.includes(value.sendMode) ? value.sendMode : "auto",
        handoffSource: legacy?.source ?? storedSource,
      };
    }
  } catch {}
  return emptyDraft();
}
// Persist synchronously before the RPC: an accepted send may lose its response.
export function prepareSend(
  storage: Storage,
  key: string,
  roomId: string,
  draft: Draft,
) {
  const parsed = parseSendMode(draft.text, draft.sendMode);
  const payload = {
    id: roomId,
    text: channelHandoffMessage(draft.handoffSource, parsed.text),
    sendMode: parsed.mode,
    attachmentIds: draft.attachments.map((a) => a.id),
    replyTo: draft.reply?.id ?? null,
  };
  const fingerprint = JSON.stringify(payload);
  const request =
    draft.request?.fingerprint === fingerprint
      ? draft.request
      : { fingerprint, id: crypto.randomUUID() };
  const next = { ...draft, request };
  storage.setItem(key, JSON.stringify(next));
  return { draft: next, payload: { ...payload, requestId: request.id } };
}

// A previous mount's accepted request must not erase text entered after navigation.
export function clearSentDraft(
  storage: Storage,
  key: string,
  sent: Draft,
): boolean {
  const current = readDraft(storage, key);
  const content = (draft: Draft) =>
    JSON.stringify([
      draft.text,
      draft.attachments.map((a) => a.id),
      draft.reply?.id ?? null,
      draft.sendMode,
      draft.handoffSource,
    ]);
  if (
    current.request?.id !== sent.request?.id ||
    content(current) !== content(sent)
  )
    return false;
  storage.setItem(key, JSON.stringify(emptyDraft()));
  return true;
}
