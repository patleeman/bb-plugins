// The floating chat. Over a Studio item it offers "Work with this…" and
// brings back the item's last chat; anywhere else it only shows a thread the
// user floated. It steps aside while the thread's own view is on screen.
import {
  experimental_NewThreadComposer as NewThreadComposer,
  ThreadChat,
  ThreadTitle,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { cn, Icon, usePathname } from "@bb-studio/kit/app";
import { STUDIO_CHAT_FLOAT_EVENT, STUDIO_CHAT_RIGHT_VAR } from "@bb-studio/kit/contract";
import { errorMessage } from "@bb-studio/kit/format";
import { useEffect, useRef, useState } from "react";
import type { rpcContract, Viewed } from "../contract";
import { MENTION_PROVIDER_ID } from "../ids";
import { itemKey } from "../context";
import { floatThread, setChat, useChat } from "./store";
import { useCardSize } from "./size";
import { HEADER_BUTTON } from "./styles";
import { ThreadMenu } from "./ThreadMenu";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const CARD = "pointer-events-auto flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl";
const THREAD_IN_PATH = /\/(thr_[a-z0-9]+)(?:\/|$)/i;

/** The Studio item on screen, or null; each path is asked once. */
function useViewing(rpc: Rpc, path: string): Viewed | null {
  const [viewed, setViewed] = useState<{ path: string; item: Viewed | null } | null>(null);
  useEffect(() => {
    if (!path.startsWith("/plugins/")) return setViewed({ path, item: null });
    let live = true;
    rpc.call("viewing", { path }).then(
      ({ item }) => live && setViewed({ path, item }),
      () => live && setViewed({ path, item: null }),
    );
    return () => {
      live = false;
    };
  }, [rpc, path]);
  // Keep the last item while the next path loads, so the bar doesn't blink.
  return viewed?.item ?? null;
}

/** Brings back the chat last used on the item when it comes on screen. */
function useItemChat(rpc: Rpc, viewed: Viewed | null) {
  const key = viewed ? itemKey(viewed) : null;
  useEffect(() => {
    if (!viewed) return;
    let live = true;
    rpc.call("lastThread", { pluginId: viewed.pluginId, id: viewed.id }).then(
      ({ threadId }) => {
        if (!live || !threadId) return;
        // Leave a chat that's being written; otherwise follow the item.
        setChat(({ mode }) => (mode === "compose" ? {} : { threadId, mode: mode === "closed" ? "minimized" : mode }));
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // The item, not its object identity, decides when to look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);
}

/** Pages and other add-ons hand a thread over with a window event. */
function useFloatEvent() {
  useEffect(() => {
    const onFloat = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: unknown }>).detail?.threadId;
      if (typeof threadId === "string" && threadId) floatThread(threadId);
    };
    window.addEventListener(STUDIO_CHAT_FLOAT_EVENT, onFloat);
    return () => window.removeEventListener(STUDIO_CHAT_FLOAT_EVENT, onFloat);
  }, []);
}

/**
 * Says what's on screen and adds it to the next message. Rendered inside the
 * thread's chat so the composer it writes to is that thread's; if BB puts the
 * pill somewhere else, the button isn't offered. On BB's SDK 0.5.29 a
 * plugin's ThreadChat doesn't scope `useComposer()` to its thread, so only
 * the label shows until it does (docs/studio-chat.md, "Limits").
 */
function ViewingChip({ threadId, viewed }: { threadId: string; viewed: Viewed }) {
  const composer = useComposer();
  const writesHere = composer.scope.kind === "thread" && composer.scope.threadId === threadId;
  const title = viewed.title.trim() || "Untitled";
  return (
    <div className="studio-chat-viewing mx-3 mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
      <Icon name={viewed.kindIcon} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Viewing: <span className="text-foreground">{title}</span>
      </span>
      {writesHere ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-state-hover"
          onClick={() => {
            composer.insertMention({ provider: MENTION_PROVIDER_ID, id: itemKey(viewed), label: title });
            composer.focus();
          }}
        >
          Add to message
        </button>
      ) : null}
    </div>
  );
}

export function ChatOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const path = usePathname();
  const viewed = useViewing(rpc, path);
  const { threadId, mode } = useChat();
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const { size, grip } = useCardSize();
  useItemChat(rpc, viewed);
  useFloatEvent();

  // Remember the thread the user starts or brings up on this item. Moving to
  // another item with a chat floating doesn't tie that chat to it.
  const linked = useRef<string | null>(null);
  useEffect(() => {
    if (!threadId || threadId === linked.current || mode === "closed") return;
    linked.current = threadId;
    if (viewed) rpc.call("link", { pluginId: viewed.pluginId, id: viewed.id, threadId }).catch(() => {});
    // Only a new thread links; `viewed` is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, threadId, mode]);

  const routeThread = path.startsWith("/plugins/") ? null : (THREAD_IN_PATH.exec(path)?.[1] ?? null);
  const hasThread = Boolean(threadId) && routeThread !== threadId;
  const showThread = hasThread && (mode === "thread" || mode === "minimized");
  const showBar = Boolean(viewed) && mode !== "thread" && mode !== "compose";
  if (!showThread && !showBar && mode !== "compose") return null;

  const kindLabel = viewed?.kindLabel.toLowerCase() ?? "item";
  const compose = () => {
    setFocus((value) => value + 1);
    setChat({ mode: "compose" });
  };

  return (
    <div
      className="studio-chat pointer-events-none fixed bottom-4 z-40 flex max-w-[calc(100vw-2.5rem)] flex-col gap-2 max-md:inset-x-2 max-md:bottom-2 max-md:!w-auto max-md:max-w-none"
      style={{ right: `var(${STUDIO_CHAT_RIGHT_VAR}, 1.5rem)`, width: size.width }}
    >
      {showThread && threadId ? (
        <section
          aria-label="Studio chat"
          className={cn(CARD, "relative", mode === "thread" && "max-h-[calc(100vh-7rem)] max-md:!h-[80vh]")}
          style={mode === "thread" ? { height: size.height } : undefined}
        >
          {mode === "thread" ? (
            <div
              role="separator"
              aria-label="Resize chat"
              title="Drag to resize. Double-click to reset."
              className="studio-chat-resize absolute top-0 left-0 z-10 size-3.5 cursor-nwse-resize touch-none rounded-tl-lg hover:bg-state-hover max-md:hidden"
              {...grip}
            />
          ) : null}
          <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
            <button
              type="button"
              aria-label={mode === "thread" ? "Minimize chat" : "Expand chat"}
              className={HEADER_BUTTON}
              onClick={() => setChat({ mode: mode === "thread" ? "minimized" : "thread" })}
            >
              <Icon name={mode === "thread" ? "Minus" : "ChevronUp"} className="size-4" />
            </button>
            <button
              type="button"
              className="studio-chat-title min-w-0 flex-1 truncate text-left text-sm font-medium"
              onClick={() => mode === "minimized" && setChat({ mode: "thread" })}
            >
              <ThreadTitle threadId={threadId} />
            </button>
            <ThreadMenu threadId={threadId} onNewChat={compose} />
            <button type="button" aria-label="Close chat" className={HEADER_BUTTON} onClick={() => setChat({ mode: "closed" })}>
              <Icon name="X" className="size-4" />
            </button>
          </header>
          {mode === "thread" ? (
            <ThreadChat
              key={threadId}
              threadId={threadId}
              variant="compact"
              className="min-h-0 flex-1"
              leadingContent={viewed ? <ViewingChip threadId={threadId} viewed={viewed} /> : null}
            />
          ) : null}
        </section>
      ) : null}

      {mode === "compose" ? (
        <section aria-label={viewed ? `Work with this ${kindLabel}` : "New chat"} className={CARD}>
          <header className="flex items-center gap-2 border-b border-border py-1.5 pr-2 pl-4 text-xs text-muted-foreground">
            {viewed ? <Icon name={viewed.kindIcon} className="size-3.5 shrink-0" /> : null}
            <span className="min-w-0 flex-1 truncate">
              {viewed
                ? `An agent works on "${viewed.title.trim() || "Untitled"}" with you. @mention a bot to hand it off.`
                : "A new thread, kept here while you move around."}
            </span>
            <button
              type="button"
              aria-label="Close composer"
              className={HEADER_BUTTON}
              onClick={() => setChat({ mode: threadId ? "minimized" : "closed" })}
            >
              <Icon name="X" className="size-4" />
            </button>
          </header>
          {error ? <p className="px-4 pt-1 text-xs text-red-500">{error}</p> : null}
          <NewThreadComposer
            key={viewed ? itemKey(viewed) : "none"}
            className="studio-chat-composer max-h-[60vh] min-h-0"
            layout="document"
            placeholder={viewed ? `Work with this ${kindLabel}…` : "Start a chat…"}
            draftKey={`studio-chat:${viewed ? itemKey(viewed) : "none"}`}
            focusRequest={focus}
            {...(viewed?.projectId ? { defaultProjectId: viewed.projectId } : {})}
            onSubmit={async (request) => {
              setError(null);
              try {
                const result = await rpc.call("start", {
                  item: viewed ? { pluginId: viewed.pluginId, id: viewed.id } : null,
                  request,
                });
                floatThread(result.threadId);
              } catch (cause) {
                setError(errorMessage(cause));
                throw cause; // Keeps the draft for another try.
              }
            }}
          />
        </section>
      ) : showBar ? (
        <button
          type="button"
          className="studio-chat-bar pointer-events-auto flex h-11 w-full items-center gap-2.5 rounded-lg border border-border bg-background px-4 text-left text-sm text-muted-foreground shadow-xl hover:text-foreground"
          onClick={compose}
        >
          <Icon name="MessageSquarePlus" className="size-4 shrink-0" />
          <span className="flex-1 truncate">Work with this {kindLabel}…</span>
        </button>
      ) : null}
    </div>
  );
}
