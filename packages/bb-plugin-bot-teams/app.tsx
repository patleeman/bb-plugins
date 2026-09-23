import { channelTabLabels } from "./channel-tab-labels";
import { UsagePanel } from "./channel-workbench";
import { AttentionInbox } from "./attention-view";
import { AttentionQuestion } from "./attention-question-view";
import { ATTENTION_QUESTION_RENDERER } from "./attention-question-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Bot, BotListItem, Conversation, Job, Room, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import {
  BackButton,
  TabBar,
  ProfileForm,
  DocumentEditor,
  WorkList,
  ErrorMessage,
  StatusBadge,
  message,
} from "./bot-ui";
import {
  ChannelsPage,
  ChannelsHeader,
  channelWorkbenchTabs,
  ChannelsSidebar,
  ChannelsNavigation,
  ChannelRedirect,
  ChannelLinkNavigation,
} from "./channels";
import { Modal } from "./channel-controls";
import { BotCollection } from "./bot-collection";
import { BotCreationThread } from "./bot-creation-thread";
import "./styles.css";
const tabs = ["profile", "mission", "memory", "activity", "usage"] as const;

function BotDetail({ id, tab }: { id: string; tab: string }) {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const [retireOpen, setRetireOpen] = useState(false);
  const [data, setData] = useState<{
      bot: Bot;
      conversations: Conversation[];
      jobs: Job[];
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const request = useRef(0);
  const load = useCallback(() => {
    const seq = ++request.current;
    rpc.call("get", { id }).then(
      (d) => {
        if (seq === request.current) {
          setData(d);
          setError(null);
        }
      },
      (e) => {
        if (seq === request.current) setError(message(e));
      },
    );
  }, [rpc, id]);
  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, [load]);
  useRealtime("changed", load);
  const action = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  if (!data)
    return (
      <div className="bot-page">
        <ErrorMessage error={error} />
        <p role="status">Loading bot…</p>
      </div>
    );
  const { bot, jobs } = data;
  const activeWork = jobs.some((job) =>
    ["queued", "dispatching", "running"].includes(job.status),
  );
  const botStatus = bot.error
    ? "error"
    : activeWork
      ? "working"
      : bot.paused || bot.retired
        ? "paused"
        : "ready";
  const statusLabel = bot.retired
    ? "Retired"
    : bot.error
      ? "Failing"
      : botStatus === "paused"
        ? "Paused"
        : botStatus === "working"
          ? "Working"
          : "Ready";
  return (
    <div className="bot-detail">
      <header className="bot-thread-bar">
        <BackButton />
        <span className="bot-inline-avatar" aria-hidden>
          {bot.avatar}
        </span>
        <h1>{bot.name}</h1>
        <TabBar
          items={tabs}
          selected={tab}
          label="Bot sections"
          onSelect={(t) =>
            navigate.toPluginPanel("bots", { subPath: `${id}/${t}` })
          }
        />
        <div className="bot-bar-actions">
          <StatusBadge status={botStatus} label={statusLabel} />
          {!bot.retired && (
            <Button
              variant={bot.paused ? "default" : "ghost"}
              size="sm"
              disabled={pending}
              onClick={() =>
                action(() => rpc.call("pause", { id, paused: !bot.paused }))
              }
            >
              {bot.paused ? "Resume" : "Pause"}
            </Button>
          )}
        </div>
      </header>
      <Modal
        title={`Retire ${bot.name}?`}
        open={retireOpen}
        onOpenChange={setRetireOpen}
      >
        <p className="text-sm leading-5">
          This stops the bot’s work and removes it from every channel. Its
          profile, mission, memory, files, and conversation history are
          preserved. You can restore it later.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setRetireOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() =>
              action(async () => {
                await rpc.call("retire", { id, retired: true });
                setRetireOpen(false);
              })
            }
          >
            Retire bot
          </Button>
        </div>
        <ErrorMessage error={error} />
      </Modal>
      {(error || bot.error) && (
        <div className="bot-error">
          <ErrorMessage error={error || bot.error} />
        </div>
      )}
      {
        <div className="bot-section">
          <div className="bot-config-content">
            {tab === "profile" && (
              <ProfileForm
                key={bot.id}
                bot={bot}
                onSaved={load}
                onRetire={() => {
                  if (bot.retired) {
                    void action(() => rpc.call("retire", { id, retired: false }));
                  } else {
                    setRetireOpen(true);
                  }
                }}
              />
            )}
            {(tab === "mission" || tab === "memory") && (
              <DocumentEditor
                key={`${id}/${tab}`}
                bot={bot}
                file={tab === "mission" ? "MISSION.md" : "MEMORY.md"}
              />
            )}
            {tab === "usage" && <UsagePanel id={id} kind="bot" />}
            {tab === "activity" && (
              <>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-muted-foreground">
                    Activity
                  </h2>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || bot.paused || bot.retired}
                    onClick={() => action(() => rpc.call("wake", { id }))}
                  >
                    Wake now
                  </Button>
                </div>
                <div className="bot-activity-panel">
                  <WorkList
                    jobs={jobs}
                    bots={[bot]}
                    onCancel={(jobId) =>
                      action(() => rpc.call("cancelJob", { id: jobId }))
                    }
                  />
                </div>
              </>
            )}
          </div>
        </div>
      }
    </div>
  );
}
function BotsPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
      bots: BotListItem[];
      rooms: Room[];
      botCreateRequests: import("./contract").BotCreateRequestView[];
    } | null>(null),
    [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(() => {
    const seq = ++request.current;
    rpc.call("list").then(
      (r) => {
        if (seq === request.current) {
          setData(r);
          setError(null);
        }
      },
      (e) => {
        if (seq === request.current) setError(message(e));
      },
    );
  }, [rpc]);
  useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, [load]);
  useRealtime("changed", load);
  const [id, section] = subPath.split("/");
  const bots = data?.bots ?? [];
  if (id === "new")
    return <BotCreationThread key={section ?? "standalone"} roomId={section} />;
  if (id === "new-group" || id === "group")
    return <ChannelRedirect subPath={id === "group" ? section : "new"} />;
  if (id)
    return (
      <div className="bot-route">
        <BotDetail
          key={id}
          id={id}
          tab={
            tabs.includes(section as (typeof tabs)[number])
              ? section
              : "profile"
          }
        />
      </div>
    );
  return (
    <BotCollection
      bots={bots}
      loading={!data}
      error={error}
      botCreateRequests={data?.botCreateRequests ?? []}
      onBotCreateRequestResolved={load}
    />
  );
}
export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: ATTENTION_QUESTION_RENDERER, component: AttentionQuestion });
  app.contentScripts.register(channelTabLabels);
  app.slots.experimental_appOverlay({
    id: "channel-links",
    component: ChannelLinkNavigation,
  });
  app.slots.navPanel({
    id: "bots",
    title: "Bot Teams",
    icon: "Bot",
    path: "bots",
    component: BotsPage,
  });
  app.slots.navPanel({
    id: "channels",
    title: "Channels",
    icon: "MessageSquare",
    path: "channels",
    component: ChannelsPage,
    headerContent: ChannelsHeader,
    fixedTabs: channelWorkbenchTabs,
  });
  app.slots.experimental_threadList({
    id: "channels",
    title: "Channels and threads",
    component: ChannelsSidebar,
  });
  app.slots.navPanel({
    id: "for-you", title: "For you", icon: "Bell", path: "for-you", component: AttentionInbox,
  });
  app.slots.experimental_sidebarNavigation({
    id: "channels",
    title: "Channels navigation",
    component: ChannelsNavigation,
  });
});
