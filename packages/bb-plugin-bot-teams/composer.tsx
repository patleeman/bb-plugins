import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
} from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Bot, Room, RoomMessage, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import {
  COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
  COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
  COARSE_POINTER_TEXT_BASE_CLASS,
} from "./components/ui/coarse-pointer-sizing";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "./components/ui/chrome-style-tokens";
import { cn } from "./lib/utils";
import { matchingBots } from "./channel-controls";
import { channelReference, matchingChannels } from "./channel-references";
import { AttachmentPreview } from "./composer-attachments";
import { ComposerMentionMenu, GlyphIcon } from "./composer-mention-menu";
import {
  useVoiceInput,
  VoiceRecordingBar,
  voiceUnsupportedMessage,
} from "./composer-voice";
import {
  emptyDraft,
  readDraft,
  prepareSend,
  clearSentDraft,
  type Draft,
} from "./draft";
import { SendModeMenu, SendModeOverride } from "./send-mode-picker";
import {
  parseSendMode,
  showsSendModeOverride,
  type SendMode,
} from "./send-mode";
import { matchingBroadcastMentions, type BroadcastMention } from "./mentions";
import { channelHandoffPath, channelHandoffText } from "./handoff-draft";

// Layout, spacing, and motion follow BB's PromptBoxInternal and
// FollowUpPromptBox so a channel composer reads like a thread composer.
const PROMPTBOX_MIN_HEIGHT = 68;
const PROMPTBOX_MAX_HEIGHT = "calc(50dvh - 3rem)";
const MAX_MESSAGE_LENGTH = 16000;
const VOICE_ACTION_TRANSITION_MS = 180;
const ACTION_GROUP_TRANSITION_CLASS =
  "transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none";

const errorText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^(HTTP \d+: )+/, "");
const prefersReducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const encode = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsDataURL(file);
  });

function insertionSeparator(current: string, block = false) {
  if (!current) return "";
  if (!block) return current.endsWith(" ") ? "" : " ";
  if (current.endsWith("\n\n")) return "";
  return current.endsWith("\n") ? "\n" : "\n\n";
}

/** Keeps the dictation strip mounted while it fades out, as BB's composer does. */
function useVoiceActionTransition(active: boolean) {
  const [present, setPresent] = useState(active);
  const [visible, setVisible] = useState(active);
  useLayoutEffect(() => {
    if (active) {
      setPresent(true);
      if (prefersReducedMotion()) {
        setVisible(true);
        return;
      }
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    if (prefersReducedMotion()) {
      setPresent(false);
      return;
    }
    const timer = setTimeout(
      () => setPresent(false),
      VOICE_ACTION_TRANSITION_MS,
    );
    return () => clearTimeout(timer);
  }, [active]);
  return { present, visible };
}

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
  railStart,
  railEnd,
}: {
  /** Left side of the row beneath the input, like a thread's environment. */
  railStart?: ReactNode;
  /** Right side of that row, like a thread's permission control. */
  railEnd?: ReactNode;
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
    block?: boolean;
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
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    alive = useRef(true),
    sending = useRef(false),
    menuItemSelected = useRef(false);
  const listId = useId();
  // BB's global CSS folds a narrow follow-up composer to one line; focus
  // unfolds it, as in a thread.
  const composerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const collapseFrame = useRef<number | null>(null);
  const cancelCollapse = () => {
    if (collapseFrame.current !== null)
      cancelAnimationFrame(collapseFrame.current);
    collapseFrame.current = null;
  };
  const scheduleCollapse = () => {
    cancelCollapse();
    collapseFrame.current = requestAnimationFrame(() => {
      collapseFrame.current = null;
      const root = composerRef.current;
      if (!root || root.contains(document.activeElement)) return;
      if (root.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
      setExpanded(false);
    });
  };
  useEffect(() => cancelCollapse, []);
  const [mention, setMention] = useState<{
      kind: "bot" | "channel";
      start: number;
      end: number;
      query: string;
    } | null>(null),
    [selection, setSelection] = useState(0);

  const insertAtCursor = useCallback((text: string) => {
    const field = editor.current;
    const current = latestDraft.current.text;
    const start = field?.selectionStart ?? current.length,
      end = field?.selectionEnd ?? current.length;
    const before = current.slice(0, start),
      after = current.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    const inserted = `${lead}${text}${trail}`;
    const source = latestDraft.current.handoffSource;
    const maxLength = MAX_MESSAGE_LENGTH -
      (source ? channelHandoffText(source).length + 2 : 0);
    setDraft((d) => ({
      ...d,
      text: (before + inserted + after).slice(0, maxLength),
    }));
    const caret = start + inserted.length;
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(caret, caret);
    });
  }, []);
  const voice = useVoiceInput({
    transcribe: async (audio, promptContext) =>
      (
        await rpc.call("transcribe", {
          data: await encode(audio),
          mimeType: audio.type,
          prompt: promptContext ?? "",
        })
      ).text,
    onTranscript: insertAtCursor,
    onError: setError,
    getPromptContext: () => {
      const field = editor.current;
      return latestDraft.current.text.slice(
        0,
        field?.selectionStart ?? undefined,
      );
    },
  });
  const voiceActive = voice.state !== "idle";
  const voiceAction = useVoiceActionTransition(voiceActive);
  const lastVoiceState = useRef<"recording" | "transcribing">("recording");
  if (voice.state !== "idle") lastVoiceState.current = voice.state;

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
  const blocked = paused || uploading || voiceActive || pending;
  const changeSendMode = (next: SendMode) =>
    setDraft((d) => ({ ...d, sendMode: next, text: parseSendMode(d.text).text }));
  const hasInput =
    !!draft.text.trim() || draft.attachments.length > 0 || !!draft.handoffSource;
  const maxTextLength = MAX_MESSAGE_LENGTH -
    (draft.handoffSource ? channelHandoffText(draft.handoffSource).length + 2 : 0);
  const canSubmit = !blocked && hasInput;
  const showMentionMenu = !!mention && !paused && !voiceActive;
  useEffect(() => {
    alive.current = true;
    rpc.call("composer").then(
      (c) => setVoiceEnabled(c.voiceEnabled),
      () => {},
    );
    return () => {
      alive.current = false;
    };
  }, [rpc]);
  useEffect(() => {
    if (insertion) {
      setDraft((d) => ({
        ...d,
        ...(insertion.sendMode ? { sendMode: insertion.sendMode } : {}),
        ...(insertion.reply ? { reply: insertion.reply } : {}),
        text: d.text + insertionSeparator(d.text, insertion.block) + insertion.text,
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
      el.style.height = `${Math.max(PROMPTBOX_MIN_HEIGHT, el.scrollHeight)}px`;
    }
  }, [draft.text]);
  // Escape cancels dictation from anywhere, as in a thread composer.
  useEffect(() => {
    if (!voiceActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      voice.cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [voiceActive, voice.cancel]);
  const attach = async (files: File[]) => {
    if (paused || pending || uploading || !files.length) return;
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
  const removeAttachment = async (a: Draft["attachments"][number]) => {
    if (sending.current || blocked) return;
    setUploading(true);
    try {
      await rpc.call("discardAttachment", { id: roomId, attachmentId: a.id });
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
  };
  const send = async () => {
    if (sending.current || !canSubmit) return;
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
  const canStartVoice =
    voice.isSupported && voiceEnabled && !paused && !pending && !uploading;
  const sendMode = (() => {
    try {
      return parseSendMode(draft.text, draft.sendMode).mode;
    } catch {
      return draft.sendMode;
    }
  })();

  return (
    <div className="group-compose-wrap">
      <div data-promptbox-shell="" className="space-y-2">
        <div
          ref={composerRef}
          className="relative z-20"
          data-follow-up-composer=""
          data-follow-up-composer-expanded={
            expanded || draft.handoffSource ? "" : undefined
          }
          onFocusCapture={() => {
            cancelCollapse();
            setExpanded(true);
          }}
          onBlurCapture={scheduleCollapse}
        >
          <form
            data-promptbox=""
            data-promptbox-voice-active={voiceActive ? "" : undefined}
            className="group-compose group/promptbox relative w-full rounded-xl border border-border bg-background shadow-lift"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            onMouseDown={(event) => {
              // Clicking the box's chrome focuses the editor, as in BB.
              if (event.target === event.currentTarget) {
                event.preventDefault();
                editor.current?.focus();
              }
            }}
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
            <input
              ref={picker}
              type="file"
              multiple
              className="hidden"
              aria-label="Choose attachments"
              onChange={(e) => {
                void attach(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            {showMentionMenu && mention ? (
              <div
                data-promptbox-typeahead-menu=""
                className="channel-mention-picker absolute -left-px -right-px bottom-full z-20 mb-2"
              >
                <ComposerMentionMenu
                  kind={mention.kind}
                  query={mention.query}
                  bots={bots}
                  memberIds={memberIds}
                  rooms={rooms}
                  currentRoomId={roomId}
                  selectedIndex={selection}
                  listId={listId}
                  onHover={setSelection}
                  onInsert={insertMention}
                  onCreateBot={createMention}
                />
              </div>
            ) : null}
            <div
              data-promptbox-main=""
              className={cn(
                "min-h-0 overflow-hidden transition-opacity duration-[180ms] motion-reduce:transition-none",
                voiceActive && "pointer-events-none",
              )}
            >
              {draft.reply ? (
                <div
                  data-promptbox-expanded-only=""
                  inert={voiceActive ? true : undefined}
                  className="flex min-w-0 items-start gap-1.5 pl-4 pr-2 pt-3 text-xs"
                >
                  <Icon
                    name="CornerDownRight"
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">
                      Replying to {draft.reply.speaker}
                    </div>
                    <div className="truncate border-l-2 border-surface-selected-border pl-2 text-muted-foreground">
                      {draft.reply.text.slice(0, 150) || "Attachment"}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Cancel reply"
                    onClick={() => setDraft((d) => ({ ...d, reply: null }))}
                    className={cn(
                      "-mt-1 h-6 w-6 p-0 [&_[data-icon-root]]:size-3.5",
                      CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                    )}
                  >
                    <Icon name="X" />
                  </Button>
                </div>
              ) : null}
              <div data-promptbox-input-region="" className="relative">
                {draft.handoffSource ? (
                  <div
                    data-channel-handoff-source=""
                    className="flex min-w-0 items-center gap-2 px-4 pt-3 text-sm"
                  >
                    <span className="shrink-0 text-muted-foreground">
                      Continue from
                    </span>
                    <span className="inline-flex min-w-0 max-w-full items-center rounded-full border border-border bg-surface-recessed text-xs leading-4">
                      <a
                        className="inline-flex min-w-0 items-center gap-1 py-0.5 pl-1 pr-1 text-foreground hover:underline"
                        href={channelHandoffPath(draft.handoffSource)}
                        title={`Open thread: ${draft.handoffSource.title}`}
                      >
                        <Icon name="UserRound" className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{draft.handoffSource.title}</span>
                      </a>
                      <button
                        type="button"
                        className="mr-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                        aria-label={`Remove thread: ${draft.handoffSource.title}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            handoffSource: null,
                          }))
                        }
                      >
                        <Icon name="X" className="size-3" aria-hidden />
                      </button>
                    </span>
                  </div>
                ) : null}
                <textarea
                  ref={editor}
                  data-promptbox-editor-scroll=""
                  autoFocus={autoFocus}
                  aria-label="Message channel"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={showMentionMenu}
                  aria-controls={showMentionMenu ? listId : undefined}
                  aria-activedescendant={
                    showMentionMenu
                      ? `${listId}-${Math.min(selection, activeOptions.length)}`
                      : undefined
                  }
                  aria-busy={voiceActive || undefined}
                  placeholder={
                    paused ? "Channel archived" : `Message #${roomName}…`
                  }
                  value={draft.text}
                  maxLength={maxTextLength}
                  disabled={paused}
                  readOnly={voiceActive}
                  rows={1}
                  className={cn(
                    "block w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pb-1 pt-3 text-foreground outline-none",
                    COARSE_POINTER_TEXT_BASE_CLASS,
                    "leading-[1.7]",
                    "placeholder:font-light placeholder:text-subtle-foreground placeholder:opacity-70",
                    "disabled:cursor-not-allowed",
                  )}
                  style={{
                    minHeight: `${PROMPTBOX_MIN_HEIGHT}px`,
                    maxHeight: PROMPTBOX_MAX_HEIGHT,
                  }}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, text: e.target.value }));
                    findMention(e.target.value, e.target.selectionStart);
                  }}
                  onClick={(e) =>
                    findMention(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart,
                    )
                  }
                  onBlur={() => setMention(null)}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.files);
                    if (files.length) {
                      e.preventDefault();
                      const text = e.clipboardData.getData("text/plain");
                      if (text && !blocked && !sending.current) {
                        const { selectionStart, selectionEnd } =
                          e.currentTarget;
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
                    if (showMentionMenu && mention) {
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
                              (e.key === "ArrowDown"
                                ? 1
                                : activeOptions.length)) %
                            (activeOptions.length + 1),
                        );
                        return;
                      }
                      if (
                        (e.key === "Enter" && !e.shiftKey) ||
                        e.key === "Tab"
                      ) {
                        e.preventDefault();
                        const item =
                          activeOptions[
                            Math.min(selection, activeOptions.length)
                          ];
                        if (item) insertMention(item);
                        else if (mention.kind === "bot") createMention();
                        else setMention(null);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
              </div>

              <div
                data-promptbox-expanded-only=""
                inert={voiceActive ? true : undefined}
              >
                <AttachmentPreview
                  attachments={draft.attachments}
                  onRemoveAttachment={
                    blocked ? undefined : (a) => void removeAttachment(a)
                  }
                />
                {error ? (
                  <div
                    role="alert"
                    className="mx-3 mb-1 mt-1 text-xs text-destructive"
                  >
                    {error}
                  </div>
                ) : null}
              </div>

              <div
                data-promptbox-action-row=""
                className="relative flex shrink-0 select-none flex-row items-center gap-3 pb-2 pl-3.5 pr-2 pt-1.5"
              >
                {voiceAction.present ? (
                  <div
                    data-promptbox-voice-controls=""
                    inert={voiceAction.visible ? undefined : true}
                    aria-hidden={voiceAction.visible ? undefined : true}
                    className={cn(
                      "absolute inset-0 z-10 min-w-0 origin-center will-change-[opacity,transform]",
                      ACTION_GROUP_TRANSITION_CLASS,
                      voiceAction.visible
                        ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
                        : "pointer-events-none translate-y-1 scale-[0.985] opacity-0",
                    )}
                  >
                    <VoiceRecordingBar
                      state={
                        voice.state === "idle"
                          ? lastVoiceState.current
                          : voice.state
                      }
                      stream={voice.stream}
                      onConfirm={voice.stop}
                      onCancel={voice.cancel}
                    />
                  </div>
                ) : null}
                <div
                  data-promptbox-expanded-only=""
                  data-promptbox-standard-actions=""
                  className={cn(
                    "flex min-w-0 flex-1 flex-row items-center gap-1",
                    ACTION_GROUP_TRANSITION_CLASS,
                    voiceActive
                      ? "pointer-events-none translate-y-1 opacity-0"
                      : "translate-y-0 opacity-100",
                  )}
                  inert={voiceActive ? true : undefined}
                  aria-live="polite"
                >
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Prompt actions"
                        disabled={paused}
                        className={cn(
                          COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
                          CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                          "-ml-1.5",
                        )}
                      >
                        <Icon
                          name={uploading ? "Spinner" : "Plus"}
                          className={cn("size-4", uploading && "animate-spin")}
                        />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      aria-label="Prompt actions"
                      align="start"
                      side="top"
                      className="w-40"
                      onCloseAutoFocus={(event) => {
                        // Leave focus where the chosen action put it.
                        if (menuItemSelected.current) event.preventDefault();
                        menuItemSelected.current = false;
                      }}
                    >
                      <DropdownMenuItem
                        disabled={uploading || pending}
                        onSelect={() => {
                          menuItemSelected.current = true;
                          picker.current?.click();
                        }}
                      >
                        <Icon
                          name={uploading ? "Spinner" : "Paperclip"}
                          className={cn(
                            "size-4 text-muted-foreground",
                            uploading && "animate-spin",
                          )}
                          aria-hidden
                        />
                        Attach files
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => {
                          menuItemSelected.current = true;
                          insertTrigger("@");
                        }}
                      >
                        <Icon
                          name="Bot"
                          className="size-4 text-muted-foreground"
                          aria-hidden
                        />
                        Mention a bot
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          menuItemSelected.current = true;
                          insertTrigger("#");
                        }}
                      >
                        <GlyphIcon
                          glyph="#"
                          className="size-4 text-sm text-muted-foreground"
                        />
                        Link a channel
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {showsSendModeOverride(sendMode) ? (
                    <SendModeOverride
                      value={sendMode}
                      disabled={blocked}
                      onChange={changeSendMode}
                    />
                  ) : null}
                </div>
                <div
                  data-promptbox-standard-actions=""
                  className={cn(
                    "flex shrink-0 flex-row items-center gap-1",
                    ACTION_GROUP_TRANSITION_CLASS,
                    voiceActive
                      ? "pointer-events-none translate-y-1 opacity-0"
                      : "translate-y-0 opacity-100",
                  )}
                  inert={voiceActive ? true : undefined}
                >
                  <Button
                    data-promptbox-expanded-only=""
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={
                      !voice.isSupported
                        ? voiceUnsupportedMessage()
                        : voiceEnabled
                          ? "Start voice input"
                          : "Start voice input (turn on voice transcription in BB settings)"
                    }
                    disabled={!canStartVoice}
                    onClick={() => void voice.start()}
                    className={COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS}
                  >
                    <Icon name="Mic" className="size-4" />
                  </Button>
                  <div
                    data-promptbox-submit-group=""
                    className="flex shrink-0 flex-row items-center"
                  >
                    {/* BB's split send button: the caret keeps the send
                        options a thread composer offers there. */}
                    <div
                      data-promptbox-send-menu=""
                      className={cn(
                        "ml-1 inline-flex items-center rounded-md",
                        "[&_button]:border-0 [&_button]:!bg-transparent [&_button]:!text-inherit [&_button]:!opacity-100 [&_button]:transition-none",
                        "[&_[data-promptbox-submit-action]]:ml-0 [&_[data-promptbox-submit-action]]:rounded-r-none",
                        hasInput
                          ? [
                              "bg-foreground text-background",
                              canSubmit ? "hover:bg-foreground/90" : "opacity-50",
                            ]
                          : "text-muted-foreground/50 ring-1 ring-inset ring-border",
                      )}
                    >
                      <Button
                        data-promptbox-submit-action=""
                        type="submit"
                        size="sm"
                        variant="default"
                        aria-label={
                          pending ? "Sending message" : "Send message"
                        }
                        disabled={!canSubmit}
                        className={cn(
                          COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
                          "transition-colors",
                        )}
                      >
                        {pending ? (
                          <Icon
                            name="Spinner"
                            className="size-4 animate-spin"
                          />
                        ) : (
                          <Icon name="CornerDownLeft" className="size-4" />
                        )}
                      </Button>
                      <SendModeMenu
                        value={sendMode}
                        hasInput={hasInput}
                        disabled={blocked}
                        onChange={changeSendMode}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </form>
          {railStart || railEnd ? (
            <div
              data-follow-up-composer-footer=""
              className="mt-1 flex min-h-6 select-none items-center justify-between gap-2 overflow-hidden pl-[15px] pr-3.5 opacity-100 transition-[max-height,min-height,margin-top,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                {railStart}
              </div>
              <div className="flex shrink-0 items-center gap-2">{railEnd}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
