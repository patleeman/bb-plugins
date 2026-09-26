import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ThreadChat,
  experimental_Icon as Icon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useAppPanel,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginFixedTabRegistration,
} from "@get-bb/plugin-sdk/app";
import type { Bot, Conversation, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ErrorMessage, message } from "./bot-ui";

const dateLabel = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(timestamp));

function useDirectData(botId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
    bot: Bot;
    conversations: Conversation[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(() => {
    const seq = ++request.current;
    rpc.call("get", { id: botId }).then(
      (result) => {
        if (seq !== request.current) return;
        setData(result);
        setError(null);
      },
      (cause) => {
        if (seq === request.current) setError(message(cause));
      },
    );
  }, [botId, rpc]);
  useEffect(() => {
    load();
    return () => { request.current++; };
  }, [load]);
  useRealtime("changed", load);
  return { data, error, load, setError };
}

const directThreads = (conversations: Conversation[]) => conversations
  .filter((conversation) => conversation.kind === "admin")
  .sort((a, b) => b.createdAt - a.createdAt);

export function BotDirectMessageHeader({ botId, selectedThreadId, threadsTab }: {
  botId: string;
  selectedThreadId?: string;
  threadsTab: PluginFixedTabRegistration;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const { data, error, load, setError } = useDirectData(botId);
  const [pending, setPending] = useState(false);
  const [titleHost, setTitleHost] = useState<Element | null>(null);
  const attachHeader = useCallback((header: HTMLDivElement | null) => {
    if (!header) return;
    const row = header.closest('[data-testid="app-page-header-content-row"]');
    setTitleHost(row?.firstElementChild?.firstElementChild?.firstElementChild ?? null);
  }, []);
  if (!data) return error ? <span role="alert">{error}</span> : null;
  const { bot } = data;
  const startNew = async () => {
    setPending(true);
    setError(null);
    try {
      await rpc.call("newConversation", { id: bot.id });
      navigate.toPluginPanel("channels", { subPath: `dm/${bot.id}` });
      load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  const title = (
    <span className="bot-direct-header-title">
      <span aria-hidden>{bot.avatar}</span>
      <span>{bot.name}</span>
      {selectedThreadId && <small>Past thread</small>}
    </span>
  );
  return (
    <div className="channel-header bot-direct-header" ref={attachHeader}>
      {titleHost ? createPortal(title, titleHost) : title}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="Direct message options">
            <Icon name="MoreHorizontal" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="Direct message options">
          <DropdownMenuItem disabled={pending || !!bot.retired} onSelect={() => void startNew()}>
            <Icon name="Plus" />
            New thread
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => panel.openFixedTab({
            surface: { kind: "current" },
            tab: threadsTab,
          })}>
            <Icon name="List" />
            Show linked threads
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate.toPluginPanel("bots", {
            subPath: `${bot.id}/profile`,
          })}>
            <Icon name="Settings" />
            Configure bot
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span role="alert" className="bot-direct-header-error">{error}</span>}
    </div>
  );
}

export function BotDirectMessagePage({
  botId,
  selectedThreadId,
  threadsTab,
}: {
  botId: string;
  selectedThreadId?: string;
  threadsTab: PluginFixedTabRegistration;
}) {
  const { data, error, load } = useDirectData(botId);
  const panel = experimental_useAppPanel();
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (openedFor.current === botId) return;
    if (panel.openFixedTab({ surface: { kind: "current" }, tab: threadsTab }))
      openedFor.current = botId;
  }, [botId, data, panel, threadsTab]);
  if (!data) return (
    <div className="bot-direct-page">
      <ErrorMessage error={error} />
      {!error && <p role="status" className="bot-direct-empty">Loading direct message…</p>}
    </div>
  );
  return (
    <div className="bot-direct-page">
      <ErrorMessage error={error} />
      <BotDirectChat bot={data.bot} conversations={data.conversations}
        selectedThreadId={selectedThreadId} onChanged={load} />
    </div>
  );
}

export function BotDirectThreadsPanel({ botId, selectedThreadId }: {
  botId: string;
  selectedThreadId?: string;
}) {
  const navigate = useBbNavigate();
  const { data, error } = useDirectData(botId);
  const threads = directThreads(data?.conversations ?? []);
  return (
    <section className="bot-direct-threads-panel" aria-label="Direct message threads">
      <ErrorMessage error={error} />
      {!data && !error && <p role="status">Loading threads…</p>}
      {data && !threads.length && <p>No direct threads yet.</p>}
      {threads.map((conversation) => {
        const current = !conversation.archivedAt;
        const subPath = current
          ? `dm/${botId}`
          : `dm/${botId}/${conversation.threadId}`;
        const selected = current ? !selectedThreadId : selectedThreadId === conversation.threadId;
        return (
          <a key={conversation.id}
            className="bot-direct-history-row"
            href={`/plugins/bot-teams/channels/${subPath}`}
            aria-current={selected ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              navigate.toPluginPanel("channels", { subPath });
            }}>
            <span>{current ? "Current thread" : dateLabel(conversation.createdAt)}</span>
            <small>{current ? dateLabel(conversation.createdAt) : "Past thread · read-only"}</small>
          </a>
        );
      })}
    </section>
  );
}

export function BotDirectChat({
  bot,
  conversations,
  selectedThreadId,
  onChanged,
}: {
  bot: Bot;
  conversations: Conversation[];
  selectedThreadId?: string;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);
  const chatRoot = useRef<HTMLDivElement>(null);
  const pickerHostRef = useRef<HTMLElement | null>(null);
  const [pickerHost, setPickerHost] = useState<HTMLElement | null>(null);
  const direct = directThreads(conversations);
  const current = direct.find((conversation) => !conversation.archivedAt);
  const selected = selectedThreadId
    ? direct.find((conversation) => conversation.threadId === selectedThreadId)
    : current;

  useEffect(() => {
    const root = chatRoot.current;
    if (!root || !selected || selected.archivedAt) return;
    const placePicker = () => {
      if (pickerHostRef.current?.isConnected) return;
      const native = Array.from(root.querySelectorAll<HTMLElement>(
        '[aria-label^="Provider, model and reasoning"]',
      )).find((item) => !item.closest(".bot-direct-composer-picker-host"));
      if (!native?.parentElement) return;
      native.setAttribute("data-bot-direct-native-picker", "");
      const host = document.createElement("span");
      host.className = "bot-direct-composer-picker-host";
      native.before(host);
      pickerHostRef.current = host;
      setPickerHost(host);
    };
    placePicker();
    const observer = new MutationObserver(placePicker);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      pickerHostRef.current?.remove();
      pickerHostRef.current = null;
      setPickerHost(null);
    };
  }, [selected?.threadId, selected?.archivedAt]);

  useEffect(() => {
    if (bot.retired || requested.current) return;
    requested.current = true;
    setPending(true);
    rpc.call("conversation", { id: bot.id }).then(
      () => {
        setError(null);
        onChanged();
      },
      (cause) => {
        setError(message(cause));
        requested.current = false;
      },
    ).finally(() => setPending(false));
  }, [bot.id, bot.retired, current, onChanged, rpc]);

  const startNew = async () => {
    if (pending || bot.retired) return;
    setPending(true);
    setError(null);
    try {
      await rpc.call("newConversation", { id: bot.id });
      navigate.toPluginPanel("channels", { subPath: `dm/${bot.id}` });
      onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  const changeModel = async (selection: {
    providerId: string;
    model: string;
    reasoningLevel: Bot["reasoningLevel"];
  }) => {
    setPending(true);
    setError(null);
    try {
      await rpc.call("update", {
        id: bot.id,
        expectedUpdatedAt: bot.updatedAt,
        ...selection,
      });
      navigate.toPluginPanel("channels", { subPath: `dm/${bot.id}` });
      onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  const handleSlashCommand = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey ||
        event.metaKey || event.nativeEvent.isComposing || !selected || selected.archivedAt)
      return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const editor = target.closest('textarea, [role="textbox"], [contenteditable="true"]');
    if (!editor || !event.currentTarget.contains(editor)) return;
    const text = editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent ?? "";
    if (text.trim() !== "/new") return;
    event.preventDefault();
    event.stopPropagation();
    void startNew();
  };

  return (
    <div className="bot-direct-chat" data-bot-direct-chat ref={chatRoot}
      onKeyDownCapture={handleSlashCommand}>
      <ErrorMessage error={error} />
      {selected ? (
        <ThreadChat key={selected.threadId} threadId={selected.threadId}
          variant={selected.archivedAt ? "timeline" : "full"}
          layout="contained" className="bot-direct-thread" />
      ) : selectedThreadId ? (
        <p role="status" className="bot-direct-empty">Thread not found in this bot's history.</p>
      ) : bot.retired ? (
        <p role="status" className="bot-direct-empty">Restore this bot to start a direct message.</p>
      ) : (
        <p role="status" className="bot-direct-empty">
          {pending ? "Starting direct message…" : "No direct message yet."}
        </p>
      )}
      {pickerHost && createPortal(
        <ProviderModelPicker
          className="bot-direct-model-picker"
          disabled={pending || !!bot.retired}
          value={{
            providerId: bot.providerId,
            model: bot.model,
            reasoningLevel: bot.reasoningLevel,
          }}
          onChange={changeModel}
          routing={{ kind: "host", hostId: bot.hostId }}
          align="start"
        />,
        pickerHost,
      )}
    </div>
  );
}
