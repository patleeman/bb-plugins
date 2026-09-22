import { useState } from "react";
import {
  useBbNavigate,
  useRpc,
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type { Bot, BotCreateRequestView, rpcContract } from "./contract";
import { Button } from "./components/ui/button";
import {
  ResourceListPanel,
  ResourceRow,
  ResourceToolbar,
} from "./components/ui/resource-list";
import { Menu } from "./channel-controls";
import { ErrorMessage, message } from "./bot-ui";

export function BotCollection({
  bots,
  loading,
  error,
  botCreateRequests,
  onBotCreateRequestResolved,
}: {
  bots: Bot[];
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
  const activeCount = bots.filter((b) => !b.retired).length;
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
              (status === "attention" ? !!b.error : !b.error))),
    )
    .sort((a, b) =>
      sort === "recent"
        ? b.createdAt - a.createdAt
        : a.name.localeCompare(b.name),
    );
  return (
    <div className="h-full overflow-y-auto" data-bots-collection>
      <div className="mx-auto box-border flex w-full max-w-5xl flex-col gap-5 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm leading-5 text-muted-foreground">
          Create and manage bots with their own workspace, mission, and memory.
        </p>
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-sm font-medium">
            {status === "retired" ? "Retired bots" : "All bots"}{" "}
            <span className="text-2xs text-subtle-foreground">
              {status === "retired" ? bots.length - activeCount : activeCount}
            </span>
          </span>
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
          <div className="rounded-lg border border-border p-6 text-center">
            <p className="text-sm font-medium">Create your first bot</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Give it a mission, choose its model, and bring it into a channel.
            </p>
          </div>
        ) : !visible.length ? (
          <div
            className="rounded-lg border border-border p-6 text-center"
            role="status"
          >
            <p className="text-sm text-muted-foreground">
              {!activeCount && status !== "retired" && !query
                ? "No active bots. Your retired bots and their files are preserved."
                : "No bots match your search or filters."}
            </p>
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
          </div>
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
                  <span
                    className={`text-xs ${bot.error ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {bot.retired
                      ? "Retired"
                      : bot.error
                        ? "Needs attention"
                        : "Ready"}
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
