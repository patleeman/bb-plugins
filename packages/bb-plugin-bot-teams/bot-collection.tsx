import { useState } from "react";
import {
  useBbNavigate,
  useRpc,
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type { BotListItem, BotCreateRequestView, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import {
  ResourceListPanel,
  ResourceRow,
  ResourceToolbar,
} from "./components/ui/resource-list";
import { Menu } from "./channel-controls";
import { EmptyState, ErrorMessage, message, StatusBadge } from "./bot-ui";

const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "narrow",
});
function relativeActivity(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60_000],
    ["hour", 3_600_000],
    ["day", 86_400_000],
    ["month", 2_592_000_000],
    ["year", 31_536_000_000],
  ];
  const [unit, milliseconds] = units.find(([, size], index) =>
    index === units.length - 1 || elapsed < units[index + 1]![1],
  )!;
  return relativeTime.format(-Math.max(1, Math.floor(elapsed / milliseconds)), unit);
}

export function BotCollection({
  bots,
  loading,
  error,
  botCreateRequests,
  onBotCreateRequestResolved,
}: {
  bots: BotListItem[];
  loading: boolean;
  error: string | null;
  botCreateRequests: BotCreateRequestView[];
  onBotCreateRequestResolved: () => void;
}) {
  const navigate = useBbNavigate(),
    rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("name");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [resolvingRequest, setResolvingRequest] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<{
    requestId: string;
    message: string;
  } | null>(null);
  const activeCount = bots.filter((bot) => !bot.retired).length;
  const retiredCount = bots.length - activeCount;
  const search = query.trim().toLowerCase();
  const visible = bots
    .filter(
      (b) =>
        `${b.name} @${b.handle} ${b.description}`
          .toLowerCase()
          .includes(search) &&
        (status === "retired"
          ? !!b.retired
          : !b.retired &&
            (status === "all" ||
              (status === "attention"
                ? !!b.error
                : status === "ready"
                  ? !b.error && !b.paused && !b.working
                  : false))),
    )
    .sort((a, b) =>
      sort === "recent"
        ? b.createdAt - a.createdAt
        : a.name.localeCompare(b.name),
    );
  return (
    <div className="h-full overflow-y-auto" data-bots-collection>
      <div className="mx-auto box-border flex w-full max-w-5xl flex-col gap-5 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {botCreateRequests.length ? (
          <section
            className="overflow-hidden rounded-lg border border-border bg-card"
            aria-labelledby="bot-creation-approvals"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2
                  id="bot-creation-approvals"
                  className="text-sm font-semibold"
                >
                  Pending bot approvals
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Review requests from bots before they get a workspace.
                </p>
              </div>
              <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium">
                {botCreateRequests.length} pending
              </span>
            </div>
            {botCreateRequests.map((request) => {
              const busy = resolvingRequest === request.id;
              return (
                <article
                  key={request.id}
                  className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span aria-hidden className="text-2xl leading-7">
                      {request.avatar}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <h3 className="text-sm font-semibold">
                          {request.name}
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          requested by {request.requesterName}
                          {request.channelName
                            ? ` in ${request.channelName}`
                            : ""}
                        </span>
                      </div>
                      {request.description ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {request.description}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                    <span>Provider: {request.providerId || "default"}</span>
                    <span>Model: {request.model || "default"}</span>
                    <span>Reasoning: {request.reasoningLevel}</span>
                    <span>Permissions: {request.permissionMode}</span>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      Mission
                    </div>
                    <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5">
                      {request.mission}
                      {request.missionTruncated ? "…" : ""}
                    </p>
                  </div>
                  <ErrorMessage
                    error={!busy && approvalError?.requestId === request.id
                      ? approvalError.message
                      : null}
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={resolvingRequest !== null}
                      onClick={async () => {
                        setResolvingRequest(request.id);
                        setApprovalError(null);
                        try {
                          await rpc.call("resolveBotCreateRequest", {
                            id: request.id,
                            approved: false,
                          });
                          onBotCreateRequestResolved();
                        } catch (cause) {
                          setApprovalError({ requestId: request.id, message: message(cause) });
                        } finally {
                          setResolvingRequest(null);
                        }
                      }}
                    >
                      Deny
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={resolvingRequest !== null}
                      onClick={async () => {
                        setResolvingRequest(request.id);
                        setApprovalError(null);
                        try {
                          await rpc.call("resolveBotCreateRequest", {
                            id: request.id,
                            approved: true,
                          });
                          onBotCreateRequestResolved();
                        } catch (cause) {
                          setApprovalError({ requestId: request.id, message: message(cause) });
                        } finally {
                          setResolvingRequest(null);
                        }
                      }}
                    >
                      Approve and create
                    </Button>
                  </div>
                </article>
              );
            })}
          </section>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-base font-semibold">
            {status === "retired" ? "Retired bots" : "Bots"}
          </h1>
          <Button
            size="sm"
            onClick={() => navigate.toPluginPanel("bots", { subPath: "new" })}
          >
            <Icon name="Plus" /> New bot
          </Button>
        </div>
        <ResourceToolbar
          value={query}
          onChange={setQuery}
          placeholder={`Search ${status === "retired" ? retiredCount : activeCount} ${status === "retired" ? "retired bots" : "bots"}`}
          controls={
            <>
              <Menu
                label="Filter bots"
                open={filterOpen}
                onOpenChange={setFilterOpen}
                trigger={
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 p-0 text-muted-foreground"
                    aria-label="Filter bots"
                    aria-pressed={status !== "all"}
                  >
                    <Icon name="SlidersHorizontal" />
                  </Button>
                }
              >
                <p className="channel-menu-label">Status</p>
                {[
                  ["all", "All bots"],
                  ["ready", "Ready"],
                  ["attention", "Needs attention"],
                  ["retired", "Retired"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className="channel-menu-row"
                    aria-pressed={status === value}
                    onClick={() => {
                      setStatus(value!);
                      setFilterOpen(false);
                    }}
                  >
                    <span className="flex-1">{label}</span>
                    {status === value && <Icon name="Check" />}
                  </button>
                ))}
              </Menu>
              <Menu
                label="Sort bots"
                open={sortOpen}
                onOpenChange={setSortOpen}
                trigger={
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 p-0 text-muted-foreground"
                    aria-label="Sort bots"
                  >
                    <Icon name="ArrowUpDown" />
                  </Button>
                }
              >
                {[
                  ["name", "Name"],
                  ["recent", "Newest first"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className="channel-menu-row"
                    aria-pressed={sort === value}
                    onClick={() => {
                      setSort(value!);
                      setSortOpen(false);
                    }}
                  >
                    <span className="flex-1">{label}</span>
                    {sort === value && <Icon name="Check" />}
                  </button>
                ))}
              </Menu>
            </>
          }
        />
        <ErrorMessage error={error} />
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading bots…
          </p>
        ) : !bots.length ? (
          <EmptyState
            title="No bots yet"
            description="Create a bot to give it a workspace, mission, and memory."
          />
        ) : !visible.length ? (
          <EmptyState
            role="status"
            title={
              !activeCount && status !== "retired" && !query
                ? "No active bots"
                : "No bots match this search"
            }
            description={
              !activeCount && status !== "retired" && !query
                ? "Retired bots and their files are preserved."
                : undefined
            }
            action={
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setStatus(!activeCount ? "retired" : "all");
                }}
              >
                {!activeCount && status !== "retired"
                  ? "View retired bots"
                  : "Clear filters"}
              </Button>
            }
          />
        ) : (
          <ResourceListPanel>
            {visible.map((bot) => (
              <ResourceRow
                key={bot.id}
                leading={bot.avatar}
                title={bot.name}
                titleMeta={`@${bot.handle}`}
                description={bot.description}
                state={
                  <span className="bot-collection-state">
                    {bot.error ? (
                      <StatusBadge status="error" label="Failing" />
                    ) : bot.working ? (
                      <StatusBadge status="working" />
                    ) : bot.paused ? (
                      <StatusBadge status="paused" />
                    ) : null}
                    <span className="bot-last-active">
                      {bot.lastActivityAt === null
                        ? "No activity yet"
                        : `Last active ${relativeActivity(bot.lastActivityAt)}`}
                    </span>
                  </span>
                }
                onOpen={() =>
                  navigate.toPluginPanel("bots", {
                    subPath: `${bot.id}/profile`,
                  })
                }
              />
            ))}
          </ResourceListPanel>
        )}
      </div>
    </div>
  );
}
