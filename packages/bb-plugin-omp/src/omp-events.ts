import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  bashArgsSchema,
  extractResultText,
  normalizeProviderCommandOutput,
  textBlockSchema,
  toNonNegativeNumber,
  toOptionalString,
  type DeltaItemShape,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";

export interface OmpEventContext {
  threadId: string;
  cwd: string;
  modelContextWindow: number | null;
}

const ASSISTANT_CHANNEL = "assistant";
const COMMAND_TOOL_NAMES = new Set(["bash"]);
const FILE_CHANGE_TOOL_NAMES = new Set(["edit", "write"]);
const IGNORED_EVENT_TYPES = new Set([
  "available_commands_update",
  "auto_retry_end",
  "auto_retry_start",
  "message_end",
  "message_start",
  "queue_update",
  "ready",
  "session_start",
  "turn_end",
]);

interface AssistantMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  providerCheckpointId?: unknown;
  usage?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const parsed = textBlockSchema.safeParse(block);
      return parsed.success ? parsed.data.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function lastAssistant(messages: unknown): AssistantMessage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}

function assistantText(message: AssistantMessage | undefined): string | undefined {
  const text = textFromContent(message?.content).trim();
  return text.length > 0 ? text : undefined;
}

function isAssistantError(message: AssistantMessage | undefined): boolean {
  return (
    message?.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.trim().length > 0
  );
}

function usageFor(message: AssistantMessage | undefined): ThreadEventTokenUsageBreakdown | undefined {
  const usage = asRecord(message?.usage);
  if (!usage) return undefined;
  const inputTokens = toNonNegativeNumber(usage.input);
  const outputTokens = toNonNegativeNumber(usage.output);
  const cachedInputTokens =
    toNonNegativeNumber(usage.cacheRead) + toNonNegativeNumber(usage.cacheWrite);
  const reportedTotal = toNonNegativeNumber(usage.totalTokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens:
      reportedTotal > 0
        ? reportedTotal
        : inputTokens + cachedInputTokens + outputTokens,
  };
}

function classifyTool(
  toolName: string,
  args: unknown,
  cwd: string,
): DeltaItemShape {
  if (COMMAND_TOOL_NAMES.has(toolName)) {
    const parsed = bashArgsSchema.safeParse(args);
    const command = parsed.success
      ? toOptionalString(parsed.data.command)
      : undefined;
    const commandCwd =
      (parsed.success ? toOptionalString(parsed.data.cwd) : undefined) ?? cwd;
    if (command && commandCwd) {
      return { type: "command", command, cwd: commandCwd };
    }
  }

  if (FILE_CHANGE_TOOL_NAMES.has(toolName)) {
    const parsed = asRecord(args);
    const path = asString(parsed?.path);
    if (path) {
      const oldText = asString(parsed?.oldText);
      const newText = asString(parsed?.newText) ?? asString(parsed?.content);
      return {
        type: "fileChange",
        changes: [
          {
            path,
            kind: oldText === undefined ? "add" : "update",
            ...(oldText === undefined ? {} : { oldText }),
            ...(newText === undefined ? {} : { newText }),
          },
        ],
      };
    }
  }

  return { type: "tool", tool: toolName, ...(args === undefined ? {} : { args }) };
}

function fallbackTool(toolName: string): DeltaItemShape {
  return FILE_CHANGE_TOOL_NAMES.has(toolName)
    ? { type: "fileChange", changes: [] }
    : { type: "tool", tool: toolName };
}

function commandOutput(content: unknown): string | undefined {
  return normalizeProviderCommandOutput({
    text: extractResultText(content),
    emptyPlaceholders: ["(no output)"],
  });
}

function progressText(content: unknown, toolName: string): string {
  const text = extractResultText(content).trim();
  return text.length > 0 ? text : `${toolName} progress update`;
}

function isCompactionNoop(errorMessage: string): boolean {
  return new Set([
    "Compaction failed: Nothing to compact (session too small)",
    "Compaction failed: Already compacted",
  ]).has(errorMessage.trim());
}

function isManualCompaction(type: string, event: Record<string, unknown>): boolean {
  // Current OMP uses the auto_compaction_* names for automatic maintenance and
  // the older compaction_* names for both manual and reason-labelled automatic
  // maintenance. Preserve the reason contract for the older event family.
  const reason = asString(event.reason);
  return reason === "manual" ||
    ((type === "compaction_start" || type === "compaction_end") && reason === undefined);
}

function compactionResultText(event: Record<string, unknown>): string | undefined {
  const result = extractResultText(event.result).trim();
  if (result.length > 0) return result;
  for (const key of ["summary", "message", "errorMessage"]) {
    const value = asString(event[key])?.trim();
    if (value) return value;
  }
  return undefined;
}

function localCommandText(event: Record<string, unknown>): string | undefined {
  for (const value of [event.text, event.output, event.content, event.result]) {
    const text = extractResultText(value).trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function rawEventDeltas(event: Record<string, unknown>): ThreadDelta[] {
  // OMP adds new event types over time. Known lifecycle noise is ignored;
  // unknown events are intentionally not rendered as fake assistant text.
  if (IGNORED_EVENT_TYPES.has(String(event.type))) return [];
  return [];
}

/** Translate OMP's Pi-compatible AgentSessionEvent stream into BB deltas. */
export function createOmpEventTranslator() {
  const toolShapes = new Map<string, DeltaItemShape>();
  const cumulativeByThread = new Map<string, ThreadEventTokenUsageBreakdown>();
  const localCommandOpen = new Set<string>();
  const localCommandCompleted = new Map<string, Set<string>>();

  function clearThreadToolShapes(threadId: string): void {
    for (const key of toolShapes.keys()) {
      if (key.startsWith(`${threadId}:`)) toolShapes.delete(key);
    }
  }

  function resetThread(threadId: string): void {
    cumulativeByThread.delete(threadId);
    clearThreadToolShapes(threadId);
    localCommandOpen.delete(threadId);
    localCommandCompleted.delete(threadId);
  }

  function translate(event: Record<string, unknown>, context: OmpEventContext): ThreadDelta[] {
    const type = asString(event.type);
    if (!type) return [];

    switch (type) {
      case "agent_start":
        return [{ kind: "turn.open" }];

      case "message_update": {
        const assistantEvent = asRecord(event.assistantMessageEvent);
        const assistantType = asString(assistantEvent?.type);
        const delta = asString(assistantEvent?.delta);
        if (assistantType === "text_delta" && delta) {
          return [{
            kind: "item.textDelta",
            key: { channel: ASSISTANT_CHANNEL },
            channel: "agentMessage",
            text: delta,
          }];
        }
        if (assistantType === "thinking_delta" && delta) {
          const contentIndex = typeof assistantEvent?.contentIndex === "number"
            ? assistantEvent.contentIndex
            : 0;
          return [{
            kind: "item.textDelta",
            key: { channel: `thinking-${contentIndex}` },
            channel: "reasoningText",
            text: delta,
          }];
        }
        if (assistantType === "thinking_end") {
          const content = asString(assistantEvent?.content) ?? "";
          const contentIndex = typeof assistantEvent?.contentIndex === "number"
            ? assistantEvent.contentIndex
            : 0;
          return [{
            kind: "item.textClose",
            key: { channel: `thinking-${contentIndex}` },
            channel: "reasoningText",
            text: content,
          }];
        }
        return [];
      }

      case "tool_execution_start": {
        const toolCallId = asString(event.toolCallId);
        const toolName = asString(event.toolName);
        if (!toolCallId || !toolName) return [];
        const item = classifyTool(toolName, event.args, context.cwd);
        toolShapes.set(`${context.threadId}:${toolCallId}`, item);
        return [{
          kind: "item.open",
          key: { providerItemId: toolCallId },
          item,
        }];
      }

      case "tool_execution_update": {
        const toolCallId = asString(event.toolCallId);
        const toolName = asString(event.toolName) ?? "tool";
        if (!toolCallId) return [];
        if (COMMAND_TOOL_NAMES.has(toolName)) {
          const snapshot = commandOutput(event.partialResult);
          return snapshot === undefined
            ? []
            : [{ kind: "command.outputSnapshot", key: { providerItemId: toolCallId }, text: snapshot }];
        }
        return [{
          kind: "item.progress",
          key: { providerItemId: toolCallId },
          message: progressText(event.partialResult, toolName),
        }];
      }

      case "tool_execution_end": {
        const toolCallId = asString(event.toolCallId);
        const toolName = asString(event.toolName);
        if (!toolCallId || !toolName) return [];
        const key = `${context.threadId}:${toolCallId}`;
        const item = toolShapes.get(key) ?? fallbackTool(toolName);
        toolShapes.delete(key);
        const failed = event.isError === true;
        const output = COMMAND_TOOL_NAMES.has(toolName)
          ? commandOutput(event.result)
          : undefined;
        return [{
          kind: "item.close",
          key: { providerItemId: toolCallId },
          status: failed ? "failed" : "completed",
          resultText: extractResultText(event.result),
          exitCode: failed ? 1 : 0,
          ...(output === undefined ? {} : { aggregatedOutput: output }),
          item,
        }];
      }

      case "command_output": {
        const text = localCommandText(event);
        if (!text) return [];
        const firstOutput = !localCommandOpen.has(context.threadId);
        localCommandOpen.add(context.threadId);
        return [
          ...(firstOutput ? [{ kind: "turn.open" as const }] : []),
          {
            kind: "item.textDelta",
            key: { channel: "local-command" },
            channel: "agentMessage",
            text,
          },
        ];
      }

      case "prompt_result": {
        if (event.agentInvoked !== false) return [];
        const promptId =
          typeof event.id === "string" || typeof event.id === "number"
            ? String(event.id)
            : undefined;
        const completed = localCommandCompleted.get(context.threadId) ?? new Set<string>();
        if (promptId && completed.has(promptId)) return [];
        if (promptId) {
          completed.add(promptId);
          localCommandCompleted.set(context.threadId, completed);
        }
        const hadOutput = localCommandOpen.delete(context.threadId);
        const resultText = !hadOutput ? localCommandText(event) : undefined;
        return [
          ...(hadOutput
            ? [{
                kind: "item.textClose" as const,
                key: { channel: "local-command" },
                channel: "agentMessage" as const,
              }]
            : [
                { kind: "turn.open" as const },
                ...(resultText
                  ? [{
                      kind: "item.textDelta" as const,
                      key: { channel: "local-command" },
                      channel: "agentMessage" as const,
                      text: resultText,
                    }, {
                      kind: "item.textClose" as const,
                      key: { channel: "local-command" },
                      channel: "agentMessage" as const,
                    }]
                  : []),
              ]),
          { kind: "turn.boundary", status: "completed" },
        ];
      }

      case "compaction_start":
      case "auto_compaction_start": {
        const reason = isManualCompaction(type, event)
          ? "manual"
          : asString(event.reason) ?? "automatic";
        const open: ThreadDelta = {
          kind: "item.open",
          key: { channel: "compaction" },
          item: { type: "compaction" },
          ...(reason === "manual" ? {} : { attach: "currentOrLast" as const }),
        };
        return reason === "manual" ? [{ kind: "turn.open" }, open] : [open];
      }

      case "compaction_end":
      case "auto_compaction_end": {
        const manual = isManualCompaction(type, event);
        const reason = manual ? "manual" : asString(event.reason) ?? "automatic";
        const errorMessage = asString(event.errorMessage);
        const aborted = event.aborted === true;
        const skipped = !aborted && Boolean(errorMessage && isCompactionNoop(errorMessage));
        const status = aborted ? "interrupted" : errorMessage && !skipped ? "failed" : "completed";
        const close: ThreadDelta = {
          kind: "item.close",
          key: { channel: "compaction" },
          status,
          item: { type: "compaction" },
          ...(compactionResultText(event)
            ? { resultText: compactionResultText(event) }
            : {}),
        };
        if (reason === "manual") {
          clearThreadToolShapes(context.threadId);
          if (!aborted && errorMessage && isCompactionNoop(errorMessage)) {
            return [
              close,
              {
                kind: "provider.warning",
                category: "compaction-skipped",
                summary: "Context compaction skipped",
                details: errorMessage,
                vouchedTurn: true,
              },
              { kind: "turn.boundary", status: "completed" },
            ];
          }
          return [
            close,
            ...(aborted || errorMessage ? [] : [{ kind: "context.compacted" as const }]),
            {
              kind: "turn.boundary",
              status: aborted ? "interrupted" : errorMessage ? "failed" : "completed",
              ...(errorMessage ? { error: { message: errorMessage } } : {}),
            },
          ];
        }
        if (!aborted && !errorMessage) return [close, { kind: "context.compacted" }];
        return [close, {
          kind: "provider.error",
          message: aborted ? "Context compaction interrupted" : "Context compaction failed",
          detail: errorMessage ?? "OMP context compaction failed",
        }];
      }

      case "agent_end": {
        const assistant = lastAssistant(event.messages);
        if (event.willRetry === true) {
          return isAssistantError(assistant)
            ? [{
                kind: "provider.error",
                message: "Provider error",
                detail: String(assistant?.errorMessage),
                willRetry: true,
              }]
            : [];
        }
        if (isAssistantError(assistant)) {
          clearThreadToolShapes(context.threadId);
          return [{
            kind: "provider.error",
            message: "Provider error",
            detail: String(assistant?.errorMessage),
            settlesTurn: true,
          }];
        }

        const deltas: ThreadDelta[] = [];
        const text = assistantText(assistant);
        if (text) {
          deltas.push({
            kind: "item.textClose",
            key: { channel: ASSISTANT_CHANNEL },
            channel: "agentMessage",
            text,
          });
        }
        const lastUsage = usageFor(assistant);
        if (lastUsage) {
          const previous = cumulativeByThread.get(context.threadId) ?? ZERO_TOKEN_USAGE;
          const total = addTokenUsage(previous, lastUsage);
          cumulativeByThread.set(context.threadId, total);
          deltas.push({
            kind: "usage",
            total,
            last: lastUsage,
            modelContextWindow: context.modelContextWindow,
          });
        }
        deltas.push({
          kind: "turn.boundary",
          status: assistant?.stopReason === "aborted" ? "interrupted" : "completed",
          ...(typeof event.providerCheckpointId === "string"
            ? { providerCheckpointId: event.providerCheckpointId }
            : {}),
          claimIfIdle: true,
        });
        clearThreadToolShapes(context.threadId);
        return deltas;
      }

      default:
        return rawEventDeltas(event);
    }
  }

  return { resetThread, translate };
}
