import { ThreadTitle, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { ItemHeader, useStudioChatPresent } from "@bb-studio/kit/app";
import { STUDIO_CHAT_FLOAT_EVENT, STUDIO_CHAT_RIGHT_VAR } from "@bb-studio/kit/contract";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { BotView, PageMetaView, RequestView } from "../contract";
import { PageConnection } from "./connection";
import { HistoryDialog, KeepUpdatedDialog } from "./dialogs";
import { PageChat, type ChatMode } from "./PageChat";
import { PageEditor, type SidePanel } from "./PageEditor";
import { actorName, FLOATING, PageMenu, relativeTime, ICON_BUTTON, type BotsState, type Project, type Rpc } from "./shared";
import { pageFieldKey, toggleTalk, useTalk, type TalkView } from "./talk";

const PAGE_ICONS = ["📄", "📝", "📋", "✅", "📊", "📈", "🗺️", "🧭", "💡", "🚀", "🧪", "🛠️", "📚", "🗓️", "🎯", "🔥", "⭐", "🧠", "🤖", "📣"];
type Chat = { threadId: string; createdAt: number };

export function useConnection(pageId: string) {
  const [connection, setConnection] = useState<PageConnection | null>(null);
  useEffect(() => {
    const next = new PageConnection(pageId);
    setConnection(next);
    return () => next.destroy();
  }, [pageId]);
  const status = useSyncExternalStore(
    useCallback((listener) => connection?.subscribe(listener) ?? (() => {}), [connection]),
    () => (connection ? `${connection.status}:${connection.synced}` : "connecting:false"),
  );
  const [state, synced] = status.split(":");
  return { connection, status: state as PageConnection["status"], synced: synced === "true" };
}

type Presence = { clientId: number; name: string; color: string; agent: boolean };

function usePresence(connection: PageConnection | null): Presence[] {
  const [presence, setPresence] = useState<Presence[]>([]);
  useEffect(() => {
    if (!connection) return;
    const read = () => {
      const seen = new Map<string, Presence>();
      for (const [clientId, state] of connection.awareness.getStates()) {
        if (clientId === connection.doc.clientID) continue;
        const user = (state as { user?: { name?: string; color?: string; agent?: boolean } }).user;
        if (!user?.name) continue;
        const key = `${user.name}:${user.agent ? 1 : 0}`;
        if (!seen.has(key)) seen.set(key, { clientId, name: user.name, color: user.color ?? "#888", agent: Boolean(user.agent) });
      }
      setPresence([...seen.values()]);
    };
    read();
    connection.awareness.on("change", read);
    return () => connection.awareness.off("change", read);
  }, [connection]);
  return presence;
}

/** A title that wraps onto more lines instead of scrolling sideways. */
function TitleField(props: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "rows">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, []);
  useEffect(fit, [fit, props.value]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);
  return (
    <textarea
      ref={ref}
      rows={1}
      placeholder="Untitled"
      aria-label="Page title"
      className="block w-full resize-none overflow-hidden bg-transparent text-[32px] leading-tight font-semibold tracking-tight outline-none placeholder:text-muted-foreground/50 max-md:text-[28px]"
      {...props}
    />
  );
}

function Smiley({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}

function IconPicker({ page, rpc, children }: { page: PageMetaView; rpc: Rpc; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-2">
        <div className="grid grid-cols-8 gap-1">
          {PAGE_ICONS.map((icon) => (
            <button key={icon} type="button" className="rounded p-1 text-lg hover:bg-state-hover" onClick={() => void rpc.call("update", { id: page.id, icon })}>
              {icon}
            </button>
          ))}
        </div>
        {page.icon ? (
          <DropdownMenuItem className="mt-1" onSelect={() => void rpc.call("update", { id: page.id, icon: "" })}>
            Remove icon
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TALK_WORKING_PHASES = new Set(["starting", "finalizing", "transcribing"]);

function DictateButton({ talk, ready, onToggle }: { talk: TalkView; ready: boolean; onToggle(): void }) {
  if (talk.mode === "unavailable") return null;
  if (talk.mode === "here") {
    const working = TALK_WORKING_PHASES.has(talk.phase);
    return (
      <button
        type="button"
        aria-pressed
        disabled={working}
        onClick={onToggle}
        className={cn(FLOATING, "flex h-8 items-center gap-1.5 rounded-md px-3 text-sm hover:bg-state-hover disabled:opacity-70")}
      >
        <Icon name={working ? "Mic" : "Square"} className={cn("size-3.5", working ? "animate-pulse" : "text-red-500")} />
        {talk.phase === "starting" ? "Starting…" : working ? "Transcribing…" : "Stop"}
      </button>
    );
  }
  const busy = talk.mode === "elsewhere";
  return (
    <button
      type="button"
      aria-label="Dictate"
      title={busy ? "Talk is busy with another recording." : "Dictate into this page with Talk"}
      disabled={busy || !ready}
      onClick={onToggle}
      className={ICON_BUTTON}
    >
      <Icon name="Mic" className="size-4" />
    </button>
  );
}

function Breadcrumbs({ page, pages }: { page: PageMetaView; pages: PageMetaView[] }) {
  const navigate = useBbNavigate();
  const trail: PageMetaView[] = [];
  let parent = page.parentId;
  while (parent && trail.length < 6) {
    const found = pages.find((candidate) => candidate.id === parent);
    if (!found) break;
    trail.unshift(found);
    parent = found.parentId;
  }
  return (
    <nav aria-label="Breadcrumbs" className={cn(FLOATING, "flex h-8 min-w-0 items-center gap-1 rounded-md px-3 text-sm text-muted-foreground max-md:hidden")}>
      {trail.map((crumb) => (
        <span key={crumb.id} className="flex min-w-0 items-center gap-1">
          <button type="button" className="max-w-40 truncate hover:text-foreground" onClick={() => navigate.toPluginPanel("pages", { subPath: crumb.id })}>
            {crumb.icon} {crumb.title || "Untitled"}
          </button>
          <Icon name="ChevronRight" className="size-3 shrink-0" />
        </span>
      ))}
      <span className="max-w-64 truncate text-foreground">
        {page.icon} {page.title || "Untitled"}
      </span>
    </nav>
  );
}

function PresenceStack({ presence }: { presence: Presence[] }) {
  if (!presence.length) return null;
  return (
    <div className="flex items-center -space-x-1.5 px-1">
      {presence.slice(0, 5).map((user) => (
        <span
          key={user.clientId}
          title={`${user.name} ${user.agent ? "is editing" : "is here"}`}
          className={cn(
            "flex size-7 items-center justify-center rounded-full border-2 border-background text-[11px] font-semibold text-white",
            user.agent && "animate-pulse",
          )}
          style={{ background: user.color }}
        >
          {[...user.name][0]?.toUpperCase()}
        </span>
      ))}
    </div>
  );
}

function ConnectionBadge({ status }: { status: PageConnection["status"] }) {
  if (status === "connected") return null;
  return (
    <span className={cn(FLOATING, "flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-amber-600 dark:text-amber-300")}>
      <span className="size-1.5 rounded-full bg-current" />
      {status === "offline" ? "Offline — changes will sync" : status === "missing" ? "Deleted" : "Connecting"}
    </span>
  );
}

const STATUS_STYLE: Record<RequestView["status"], string> = {
  queued: "text-muted-foreground",
  working: "text-violet-500",
  done: "text-emerald-500",
  failed: "text-red-500",
};
const STATUS_ICON: Record<RequestView["status"], string> = {
  queued: "Clock",
  working: "Spinner",
  done: "CircleCheck",
  failed: "AlertCircle",
};
const STATUS_VERB: Record<RequestView["status"], string> = {
  queued: "will pick up",
  working: "is working on",
  done: "finished",
  failed: "couldn't finish",
};

/** Bot requests, the keep-updated schedule and page chats, behind one pill. */
function ActivityPill({
  page,
  refreshBot,
  requests,
  chats,
  onOpenThread,
  onConfigure,
  onRefresh,
}: {
  page: PageMetaView;
  refreshBot: BotView | undefined;
  requests: RequestView[];
  chats: Chat[];
  onOpenThread(threadId: string): void;
  onConfigure(): void;
  onRefresh(): void;
}) {
  if (!page.refresh && !requests.length && !chats.length) return null;
  const active = requests.filter((request) => request.status === "queued" || request.status === "working");
  const label = active.length
    ? `${active[0]!.botName} is working${active.length > 1 ? ` +${active.length - 1}` : ""}`
    : page.refresh
      ? "Kept updated"
      : "Activity";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Page activity: ${label}`}
          className={cn(FLOATING, "flex h-8 max-w-56 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-active")}
        >
          <Icon
            name={active.length ? "Spinner" : page.refresh ? "Repeat" : "Clock"}
            className={cn("size-3.5 shrink-0", active.length && "text-violet-500")}
          />
          <span className="truncate max-md:sr-only">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-80 overflow-auto">
        {page.refresh ? (
          <>
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              Kept updated by <span className="text-foreground">{refreshBot ? `${refreshBot.avatar} ${refreshBot.name}` : "a bot"}</span>
              {page.refresh.nextAt
                ? ` · next ${new Date(page.refresh.nextAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
                : ""}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={onRefresh}>
              <Icon name="RotateCcw" className="size-4" /> Refresh now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onConfigure}>
              <Icon name="SlidersHorizontal" className="size-4" /> Update settings…
            </DropdownMenuItem>
          </>
        ) : null}
        {requests.length ? (
          <>
            {page.refresh ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs text-muted-foreground">Bot requests</DropdownMenuLabel>
            {requests.slice(0, 8).map((request) => (
              <DropdownMenuItem
                key={request.id}
                disabled={!request.threadId}
                className="items-start"
                onSelect={() => request.threadId && onOpenThread(request.threadId)}
              >
                <Icon name={STATUS_ICON[request.status]} className={cn("mt-0.5 size-3.5 shrink-0", STATUS_STYLE[request.status])} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2">
                    {request.botName} {STATUS_VERB[request.status]}{" "}
                    {request.kind === "refresh" ? "a refresh" : request.kind === "comment" ? "a comment" : "a request"}
                    {request.summary && request.kind !== "refresh" ? `: “${request.summary}”` : ""}
                  </span>
                  {request.error ? <span className="line-clamp-2 text-xs text-red-500">{request.error}</span> : null}
                  <span className="text-xs text-muted-foreground">{relativeTime(request.updatedAt)}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {chats.length ? (
          <>
            {page.refresh || requests.length ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs text-muted-foreground">Chats</DropdownMenuLabel>
            {chats.map((chat) => (
              <DropdownMenuItem key={chat.threadId} onSelect={() => onOpenThread(chat.threadId)}>
                <Icon name="MessageSquare" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="pages-thread-title min-w-0 flex-1 truncate">
                  <ThreadTitle threadId={chat.threadId} />
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(chat.createdAt)}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PageView({
  page,
  pages,
  bots,
  projects,
  rpc,
  requestsVersion,
  chatThreadId,
  onCreateInside,
  onDeleted,
  backLabel,
  onBack,
}: {
  page: PageMetaView;
  pages: PageMetaView[];
  bots: BotsState;
  projects: Project[];
  rpc: Rpc;
  requestsVersion: number;
  /** A chat to show in its card, when the route names one. */
  chatThreadId: string | null;
  onCreateInside(): void;
  onDeleted(): void;
  /** "Studio" when Studio is installed, else "Pages". */
  backLabel: string;
  onBack(): void;
}) {
  const { connection, status, synced } = useConnection(page.id);
  const presence = usePresence(connection);
  const talk = useTalk(pageFieldKey(page.id));
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [dialog, setDialog] = useState<"refresh" | "history" | null>(null);
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatThread, setChatThread] = useState<string | null>(chatThreadId);
  const [chatMode, setChatMode] = useState<ChatMode>(chatThreadId ? "thread" : "closed");
  const [title, setTitle] = useState(page.title);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingTitle = useRef(false);

  useEffect(() => {
    if (!editingTitle.current) setTitle(page.title);
  }, [page.title]);
  useEffect(() => {
    rpc.call("requests", { pageId: page.id }).then((result) => setRequests(result.requests), () => {});
  }, [rpc, page.id, requestsVersion]);
  const loadChats = useCallback(() => {
    rpc.call("chats", { pageId: page.id }).then((result) => setChats(result.chats), () => {});
  }, [rpc, page.id]);
  useEffect(loadChats, [loadChats]);

  const saveTitle = (next: string) => {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => void rpc.call("update", { id: page.id, title: next.trim() }), 400);
  };
  // Studio Chat, when installed, holds the page's chats; Pages' own card
  // steps aside for it.
  const studioChat = useStudioChatPresent();
  const openThread = (threadId: string) => {
    if (studioChat) {
      window.dispatchEvent(new CustomEvent(STUDIO_CHAT_FLOAT_EVENT, { detail: { threadId } }));
      return;
    }
    setChatThread(threadId);
    setChatMode("thread");
  };
  useEffect(() => {
    if (chatThreadId && studioChat !== null) openThread(chatThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatThreadId, studioChat]);
  // Keeps Studio Chat clear of the comments card.
  const besideComments = sidePanel === "comments";
  useEffect(() => {
    if (!studioChat || !besideComments || !window.matchMedia("(min-width: 768px)").matches) return;
    const root = document.documentElement.style;
    root.setProperty(STUDIO_CHAT_RIGHT_VAR, "344px");
    return () => void root.removeProperty(STUDIO_CHAT_RIGHT_VAR);
  }, [studioChat, besideComments]);

  const refreshBot = page.refresh ? bots.bots.find((bot) => bot.id === page.refresh!.botId) : undefined;
  const shown = { ...page, title };

  return (
    // Floating chrome, the comments card and the chat are placed against this box.
    <div className="pages-doc relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={cn("mx-auto w-full max-w-[828px] pt-24 pb-40 max-md:pt-16", sidePanel && "min-[1280px]:max-w-[1168px] min-[1280px]:pr-[340px]")}>
          <div className="group/title px-[54px] max-md:px-4">
            {page.icon ? (
              <IconPicker page={page} rpc={rpc}>
                <button type="button" aria-label="Change icon" className="mb-3 rounded-md text-[44px] leading-none hover:bg-state-hover">
                  {page.icon}
                </button>
              </IconPicker>
            ) : null}
            <div className="relative">
              {!page.icon ? (
                <IconPicker page={page} rpc={rpc}>
                  <button
                    type="button"
                    aria-label="Add icon"
                    title="Add icon"
                    className="pages-reveal absolute top-2.5 -left-9 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/title:opacity-100 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 max-md:static max-md:mb-1 max-md:-ml-1.5"
                  >
                    <Smiley className="size-[18px]" />
                  </button>
                </IconPicker>
              ) : null}
              <TitleField
                value={title}
                // A new page starts with its title, like a new document.
                autoFocus={!page.title && !page.archived}
                onFocus={() => (editingTitle.current = true)}
                onBlur={() => (editingTitle.current = false)}
                onChange={(event) => saveTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    (document.querySelector(".pages-editor .bn-editor") as HTMLElement | null)?.focus();
                  }
                }}
              />
            </div>
            {page.archived ? (
              <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Icon name="Archive" className="size-3.5" /> Archived
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => void rpc.call("update", { id: page.id, archived: false })}
                >
                  Restore
                </button>
              </div>
            ) : null}
          </div>
          <div className="mt-5 flex">
            {connection && synced ? (
              <PageEditor
                connection={connection}
                page={page}
                bots={bots.bots}
                pages={pages}
                sidePanel={sidePanel}
                onCloseSidePanel={() => setSidePanel(null)}
              />
            ) : status === "missing" ? (
              <p className="px-[54px] text-sm text-muted-foreground max-md:px-4">This page no longer exists.</p>
            ) : (
              <p className="px-[54px] text-sm text-muted-foreground max-md:px-4">Connecting…</p>
            )}
          </div>
        </div>
      </div>

      <ItemHeader
        backLabel={backLabel}
        onBack={onBack}
        leading={<Breadcrumbs page={shown} pages={pages} />}
        trailing={
          <>
          <ConnectionBadge status={status} />
          <ActivityPill
            page={page}
            refreshBot={refreshBot}
            requests={requests}
            chats={chats}
            onOpenThread={openThread}
            onConfigure={() => setDialog("refresh")}
            onRefresh={() => void rpc.call("refreshNow", { id: page.id }).catch((error: unknown) => window.alert(String(error)))}
          />
          <PresenceStack presence={presence} />
          <DictateButton talk={talk} ready={Boolean(connection && synced)} onToggle={() => toggleTalk(pageFieldKey(page.id))} />
          <button type="button" aria-label="Version history" title="Version history" className={cn(ICON_BUTTON, "max-md:hidden")} onClick={() => setDialog("history")}>
            <Icon name="RotateCcw" className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Comments"
            title="Comments"
            aria-pressed={sidePanel === "comments"}
            className={ICON_BUTTON}
            onClick={() => setSidePanel((panel) => (panel === "comments" ? null : "comments"))}
          >
            <Icon name="MessageSquare" className="size-4" />
          </button>
          <PageMenu
            page={page}
            rpc={rpc}
            projects={projects}
            onChanged={() => {}}
            onDeleted={onDeleted}
            triggerClassName={ICON_BUTTON}
            leading={
              <>
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Edited {relativeTime(page.updatedAt)} by {actorName(page.updatedBy, bots.bots)}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onCreateInside}>
                  <Icon name="Plus" className="size-4" /> Add a page inside
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog("refresh")} disabled={!bots.available}>
                  <Icon name="Repeat" className="size-4" />
                  <span className="flex min-w-0 flex-col">
                    Keep updated…
                    {!bots.available ? <span className="text-xs text-muted-foreground">{bots.reason ?? "Studio Teams is not available."}</span> : null}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem className="md:hidden" onSelect={() => setDialog("history")}>
                  <Icon name="RotateCcw" className="size-4" /> Version history…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void rpc.call("markdown", { id: page.id }).then((result) => navigator.clipboard.writeText(result.markdown))}
                >
                  <Icon name="Copy" className="size-4" /> Copy as Markdown
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            }
          />
          </>
        }
      />

      {studioChat === false ? (
        <PageChat
          page={page}
          rpc={rpc}
          threadId={chatThread}
          mode={chatMode}
          onMode={setChatMode}
          besideComments={besideComments}
          onStarted={(threadId) => {
            openThread(threadId);
            loadChats();
          }}
        />
      ) : null}
      <KeepUpdatedDialog open={dialog === "refresh"} onClose={() => setDialog(null)} page={page} bots={bots} rpc={rpc} />
      <HistoryDialog open={dialog === "history"} onClose={() => setDialog(null)} page={page} bots={bots.bots} rpc={rpc} />
    </div>
  );
}
