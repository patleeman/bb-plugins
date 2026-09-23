import { useEffect, useRef, useState, useId, type ReactNode } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Bot, Room, RoomMessage, rpcContract } from "./contract";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "./components/ui/button";
import { BotOptions, ChannelOptions, matchingBots } from "./channel-controls";
import { channelReference, matchingChannels } from "./channel-references";
import { ChannelAttachments } from "./channel-attachments";
import {
  emptyDraft,
  readDraft,
  prepareSend,
  clearSentDraft,
  type Draft,
} from "./draft";
import { SendModePicker } from "./send-mode-picker";
import { parseSendMode, type SendMode } from "./send-mode";
import { matchingBroadcastMentions, type BroadcastMention } from "./mentions";

const errorText = (e: unknown) => {
  if (e instanceof DOMException && e.name === "NotAllowedError")
    return "Allow microphone access to dictate a message.";
  return (e instanceof Error ? e.message : String(e)).replace(
    /^(HTTP \d+: )+/,
    "",
  );
};
/** Live input level bars, matching BB's thread dictation strip. */
function Waveform({ stream }: { stream: MediaStream | null }) {
  const [levels, setLevels] = useState<number[]>(() => Array(48).fill(0));
  useEffect(() => {
    if (!stream || typeof AudioContext === "undefined") return;
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 256;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0,
      last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 60) return;
      last = now;
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v - 128) / 128);
      setLevels((old) => [...old.slice(1), Math.min(1, peak * 2.5)]);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      void audio.close();
    };
  }, [stream]);
  return (
    <div className="group-compose-waveform" aria-hidden="true">
      {levels.map((level, i) => (
        <span key={i} style={{ height: `${Math.max(3, level * 18)}px` }} />
      ))}
    </div>
  );
}
const encode = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsDataURL(file);
  });
export function GroupComposer({
  autoFocus = false,
  roomId,
  roomName,
  paused,
  reply,
  onClearReply,
  insertion,
  onInserted,
  onSent,
  bots,
  memberIds,
  rooms,
  onCreateBot,
  footer,
  shelf,
}: {
  footer?: ReactNode;
  /** Work and queue for this channel, attached to the top of the input. */
  shelf?: ReactNode;
  autoFocus?: boolean;
  bots: Bot[];
  memberIds: string[];
  rooms: Room[];
  onCreateBot: () => void;
  roomId: string;
  roomName: string;
  paused: boolean;
  reply: RoomMessage | null;
  onClearReply: () => void;
  insertion: {
    text: string;
    nonce: number;
    sendMode?: SendMode;
    reply?: RoomMessage;
  } | null;
  onInserted: () => void;
  onSent: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>(),
    key = `bb:bots:draft:${roomId}`;
  const [draft, setDraftState] = useState(() => readDraft(localStorage, key)),
    [pending, setPending] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState<string | null>(null);
  const latestDraft = useRef(draft);
  const setDraft = (update: Draft | ((draft: Draft) => Draft)) => {
    const next =
      typeof update === "function" ? update(latestDraft.current) : update;
    latestDraft.current = next;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
    setDraftState(next);
  };
  const [voiceEnabled, setVoiceEnabled] = useState(false),
    [voice, setVoice] = useState<
      "idle" | "starting" | "recording" | "transcribing"
    >("idle");
  const editor = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    recording = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    alive = useRef(true),
    sending = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    discard = useRef(false);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const listId = useId();
  const [mention, setMention] = useState<{
      kind: "bot" | "channel";
      start: number;
      end: number;
      query: string;
    } | null>(null),
    [selection, setSelection] = useState(0);
  const options =
    mention?.kind === "bot"
      ? [
          ...matchingBroadcastMentions(mention.query),
          ...matchingBots(bots, memberIds, mention.query),
        ]
      : [];
  const channelOptions =
    mention?.kind === "channel"
      ? matchingChannels(rooms, roomId, mention.query)
      : [];
  const activeOptions = mention?.kind === "channel" ? channelOptions : options;
  const findMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const botMatch = before.match(/(?:^|[\s(])@([a-z0-9_-]*)$/i);
    const channelMatch = before.match(/(?:^|[\s(])#([a-z0-9_-]*)$/i);
    const match =
      botMatch && channelMatch
        ? (botMatch.index ?? 0) > (channelMatch.index ?? 0)
          ? { kind: "bot" as const, match: botMatch }
          : { kind: "channel" as const, match: channelMatch }
        : botMatch
          ? { kind: "bot" as const, match: botMatch }
          : channelMatch
            ? { kind: "channel" as const, match: channelMatch }
            : null;
    setMention(
      match
        ? {
            kind: match.kind,
            start: caret - match.match[1]!.length - 1,
            end: caret,
            query: match.match[1]!,
          }
        : null,
    );
    setSelection(0);
  };
  const insertMention = (item: Bot | Room | BroadcastMention) => {
    if (!mention) return;
    const text =
      "handle" in item ? `@${item.handle} ` : `${channelReference(item)} `;
    setDraft((d) => ({
      ...d,
      text: d.text.slice(0, mention.start) + text + d.text.slice(mention.end),
    }));
    const caret = mention.start + text.length;
    setMention(null);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(caret, caret);
    });
  };
  const createMention = () => {
    if (!mention || mention.kind !== "bot") return;
    setMention(null);
    onCreateBot();
  };
  const editorBlocked = paused || uploading || voice !== "idle";
  const blocked = editorBlocked || pending;
  useEffect(() => {
    alive.current = true;
    rpc.call("composer").then(
      (c) => setVoiceEnabled(c.voiceEnabled),
      () => {},
    );
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (recording.current?.state === "recording") recording.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [rpc]);
  useEffect(() => {
    if (insertion) {
      setDraft((d) => ({
        ...d,
        ...(insertion.sendMode ? { sendMode: insertion.sendMode } : {}),
        ...(insertion.reply ? { reply: insertion.reply } : {}),
        text: `${d.text}${d.text && !d.text.endsWith(" ") ? " " : ""}${insertion.text}`,
      }));
      setMention(null);
      onInserted();
      editor.current?.focus();
    }
  }, [insertion]);
  useEffect(() => {
    if (reply) {
      setDraft((d) => ({ ...d, reply }));
      onClearReply();
      editor.current?.focus();
    }
  }, [reply]);
  useEffect(() => {
    const el = editor.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(220, Math.max(68, el.scrollHeight))}px`;
    }
  }, [draft.text]);
  const attach = async (files: File[]) => {
    if (blocked || !files.length) return;
    setError(null);
    if (draft.attachments.length + files.length > 10) {
      setError("Attach up to 10 files per message.");
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024)
          throw new Error(`${file.name} exceeds 8 MB.`);
        const a = await rpc.call("upload", {
          id: roomId,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data: await encode(file),
        });
        if (alive.current)
          setDraft((d) => ({
            ...d,
            attachments: [...d.attachments.filter((x) => x.id !== a.id), a],
          }));
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setUploading(false);
    }
  };
  const send = async () => {
    if (
      sending.current ||
      blocked ||
      (!draft.text.trim() && !draft.attachments.length)
    )
      return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      const prepared = prepareSend(
        localStorage,
        key,
        roomId,
        latestDraft.current,
      );
      setDraft(prepared.draft);
      await rpc.call("send", prepared.payload);
      const cleared = clearSentDraft(localStorage, key, prepared.draft);
      if (alive.current) {
        if (cleared) setDraft(emptyDraft());
        onClearReply();
        onSent();
        editor.current?.focus();
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      sending.current = false;
      if (alive.current) setPending(false);
    }
  };
  // Insert a mention trigger at the caret and open its picker.
  const insertTrigger = (char: "@" | "#") => {
    const field = editor.current;
    const text = latestDraft.current.text;
    const start = field?.selectionStart ?? text.length,
      end = field?.selectionEnd ?? text.length;
    const lead = start > 0 && !/\s|\(/.test(text[start - 1]!) ? " " : "";
    const next = text.slice(0, start) + lead + char + text.slice(end);
    const caret = start + lead.length + 1;
    setDraft((d) => ({ ...d, text: next }));
    findMention(next, caret);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(caret, caret);
    });
  };
  const dictate = async () => {
    if (voice === "recording") {
      recording.current?.stop();
      return;
    }
    if (blocked || !voiceEnabled) return;
    setError(null);
    setVoice("starting");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Dictation needs microphone access in a supported browser.",
        );
      const media = await navigator.mediaDevices.getUserMedia({
        audio: localStorage.getItem("bb.voiceInput.audioInputDeviceId")
          ? {
              deviceId: {
                ideal: localStorage.getItem(
                  "bb.voiceInput.audioInputDeviceId",
                )!,
              },
            }
          : true,
      });
      if (!alive.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      discard.current = false;
      setLiveStream(media);
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      const recorder = new MediaRecorder(
        media,
        mime ? { mimeType: mime } : undefined,
      );
      recording.current = recorder;
      const chunks: Blob[] = [];
      let failed = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onerror = () => {
        failed = true;
        if (timer.current) clearTimeout(timer.current);
        media.getTracks().forEach((t) => t.stop());
        setLiveStream(null);
        if (alive.current) {
          setVoice("idle");
          setError("Microphone recording failed. Try again.");
        }
      };
      recorder.onstop = async () => {
        if (timer.current) clearTimeout(timer.current);
        if (!failed) media.getTracks().forEach((t) => t.stop());
        recording.current = null;
        stream.current = null;
        setLiveStream(null);
        if (!alive.current || failed) return;
        if (discard.current) {
          setVoice("idle");
          return;
        }
        setVoice("transcribing");
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          if (blob.size > 5 * 1024 * 1024)
            throw new Error("Recording exceeds 5 MB. Try a shorter message.");
          const result = await rpc.call("transcribe", {
            data: await encode(blob),
            mimeType: blob.type,
            prompt: draft.text,
          });
          if (alive.current) {
            setDraft((d) => ({
              ...d,
              text: `${d.text}${d.text ? " " : ""}${result.text}`,
            }));
            editor.current?.focus();
          }
        } catch (e) {
          if (alive.current) setError(errorText(e));
        } finally {
          if (alive.current) setVoice("idle");
        }
      };
      recorder.start();
      setVoice("recording");
      timer.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 120000);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      setError(errorText(e));
      setVoice("idle");
    }
  };
  return (
    <div className="group-compose-wrap" data-shelf={shelf ? "" : undefined}>
      {mention && !editorBlocked && (
        <div className="channel-mention-picker">
          {mention.kind === "channel" ? (
            <ChannelOptions
              rooms={rooms}
              currentRoomId={roomId}
              query={mention.query}
              selected={Math.min(selection, channelOptions.length)}
              listId={listId}
              onHover={setSelection}
              onSelect={insertMention}
            />
          ) : (
            <BotOptions
              bots={bots}
              memberIds={memberIds}
              query={mention.query}
              selected={Math.min(selection, options.length)}
              listId={listId}
              onHover={setSelection}
              onSelect={insertMention}
              onCreate={createMention}
              onBroadcast={insertMention}
            />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="bot-compose-error">
          {error}
        </p>
      )}
      {shelf}
      <div
        className="group-compose group/promptbox relative w-full rounded-xl border border-border bg-background shadow-lift"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            void attach(Array.from(e.dataTransfer.files));
          }
        }}
      >
        {draft.reply && (
          <div className="group-reply-preview">
            <Icon name="CornerDownRight" />
            <span>
              <strong>Replying to {draft.reply.speaker}</strong>
              <span>{draft.reply.text.slice(0, 150) || "Attachment"}</span>
            </span>
            <button
              aria-label="Cancel reply"
              onClick={() => setDraft((d) => ({ ...d, reply: null }))}
            >
              <Icon name="X" />
            </button>
          </div>
        )}
        {!!draft.attachments.length && (
          <ChannelAttachments
            attachments={draft.attachments}
            disabled={pending}
            onRemove={async (a) => {
              if (sending.current || blocked) return;
              setUploading(true);
              try {
                await rpc.call("discardAttachment", {
                  id: roomId,
                  attachmentId: a.id,
                });
                if (alive.current)
                  setDraft((d) => ({
                    ...d,
                    attachments: d.attachments.filter((x) => x.id !== a.id),
                  }));
              } catch (e) {
                if (alive.current) setError(errorText(e));
              } finally {
                if (alive.current) setUploading(false);
              }
            }}
          />
        )}
        <textarea
          ref={editor}
          autoFocus={autoFocus}
          aria-label="Message channel"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!!mention && !editorBlocked}
          aria-controls={mention ? listId : undefined}
          aria-activedescendant={
            mention
              ? `${listId}-${Math.min(selection, activeOptions.length)}`
              : undefined
          }
          placeholder={paused ? "Channel archived" : `Message #${roomName}…`}
          value={draft.text}
          maxLength={16000}
          disabled={editorBlocked}
          rows={1}
          onChange={(e) => {
            setDraft((d) => ({ ...d, text: e.target.value }));
            findMention(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) =>
            findMention(e.currentTarget.value, e.currentTarget.selectionStart)
          }
          onBlur={(e) => {
            if (!e.relatedTarget?.closest(".channel-mention-picker"))
              setMention(null);
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              if (text && !blocked && !sending.current) {
                const { selectionStart, selectionEnd } = e.currentTarget;
                setDraft((d) => ({
                  ...d,
                  text: (
                    d.text.slice(0, selectionStart) +
                    text +
                    d.text.slice(selectionEnd)
                  ).slice(0, 16000),
                }));
              }
              void attach(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (mention && !editorBlocked) {
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSelection(
                  (value) =>
                    (value +
                      (e.key === "ArrowDown" ? 1 : activeOptions.length)) %
                    (activeOptions.length + 1),
                );
                return;
              }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                e.preventDefault();
                const item =
                  activeOptions[Math.min(selection, activeOptions.length)];
                if (item) insertMention(item);
                else if (mention.kind === "bot") createMention();
                else setMention(null);
                return;
              }
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="group-compose-controls">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {voice === "recording" ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                aria-label="Cancel dictation"
                onClick={() => {
                  discard.current = true;
                  recording.current?.stop();
                }}
              >
                <Icon name="X" />
              </Button>
              <Waveform stream={liveStream} />
              <Button
                size="icon"
                className="h-8 w-8 rounded-full max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                aria-label="Finish dictation"
                onClick={() => void dictate()}
              >
                <Icon name="Check" />
              </Button>
            </>
          ) : (
            <>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                    aria-label="Add to message"
                    disabled={blocked}
                  >
                    <Icon name="Plus" />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    side="top"
                    sideOffset={4}
                    collisionPadding={8}
                    className="channel-popover channel-add-menu"
                  >
                    <DropdownMenu.Item
                      className="channel-menu-row"
                      onSelect={() => picker.current?.click()}
                    >
                      <Icon name="Paperclip" />
                      Attach files
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="channel-menu-separator" />
                    <DropdownMenu.Item
                      className="channel-menu-row"
                      onSelect={() => insertTrigger("@")}
                    >
                      <Icon name="AtSign" />
                      Mention a bot
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="channel-menu-row"
                      onSelect={() => insertTrigger("#")}
                    >
                      <Icon name="Hash" />
                      Link a channel
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <span className="group-compose-hint" role="status">
                {pending
                  ? "Sending…"
                  : uploading
                    ? "Uploading…"
                    : voice === "transcribing"
                      ? "Transcribing…"
                      : voice === "starting"
                        ? "Opening microphone…"
                        : ""}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                aria-label={
                  voiceEnabled
                    ? "Dictate message"
                    : "Dictate message (enable voice transcription in BB settings)"
                }
                disabled={
                  !voiceEnabled ||
                  paused ||
                  pending ||
                  uploading ||
                  ["starting", "transcribing"].includes(voice)
                }
                onClick={() => void dictate()}
              >
                <Icon name="Mic" />
              </Button>
          <SendModePicker
            value={(() => {
              try {
                return parseSendMode(draft.text, draft.sendMode).mode;
              } catch {
                return draft.sendMode;
              }
            })()}
            disabled={blocked}
            onChange={(sendMode) =>
              setDraft((d) => ({
                ...d,
                sendMode,
                text: parseSendMode(d.text).text,
              }))
            }
          />
          <Button
            size="icon"
            className="h-8 w-8 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
            aria-label="Send message"
            disabled={
              blocked || (!draft.text.trim() && !draft.attachments.length)
            }
            onClick={() => void send()}
          >
            <Icon name="CornerDownLeft" />
          </Button>
            </>
          )}
        </div>
      </div>
      {footer && <div className="group-compose-footer">{footer}</div>}
    </div>
  );
}
