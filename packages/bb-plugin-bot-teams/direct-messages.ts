type ThreadEvent = {
  type: string;
  scope: { kind: string; turnId?: string };
  createdAt: number;
  data: unknown;
};

const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export type DirectMessageRequest = {
  requestId: string;
  createdAt: number;
};

export const directMessageId = (threadId: string, requestId: string) =>
  `dm:${threadId}:${requestId}`;

type AcceptedRequest = DirectMessageRequest & {
  source: unknown;
  initiator: unknown;
  senderThreadId: unknown;
  texts: string[];
};

/** BB's accepted inputs for the latest turn, matched by request ID. */
function acceptedRequestsInTurn(
  events: readonly ThreadEvent[],
  phase: "active" | "completed",
): AcceptedRequest[] {
  const boundary = events.find((event) =>
    event.type === (phase === "active" ? "turn/started" : "turn/completed"),
  );
  if (!boundary || boundary.scope.kind !== "turn") return [];
  const accepted = new Set(
    events.flatMap((event) =>
      event.type === "turn/input/accepted" &&
      event.scope.kind === "turn" &&
      event.scope.turnId === boundary.scope.turnId
        ? [fields(event.data).clientRequestId]
        : [],
    ).filter((id): id is string => typeof id === "string"),
  );
  return events
    .flatMap((event) => {
      if (event.type !== "client/turn/requested") return [];
      const request = fields(event.data);
      if (typeof request.requestId !== "string" || !accepted.has(request.requestId))
        return [];
      const input = Array.isArray(request.input) ? request.input : [];
      return [{
        requestId: request.requestId,
        createdAt: event.createdAt,
        source: request.source,
        initiator: request.initiator,
        senderThreadId: request.senderThreadId,
        texts: input.flatMap((block) => {
          const part = fields(block);
          return part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : [];
        }),
      }];
    })
    .reverse();
}

/** Accepted owner messages in the current turn, excluding Bot Teams job prompts. */
export function directMessagesInTurn(
  events: readonly ThreadEvent[],
  phase: "active" | "completed",
  managedPrompts: readonly string[] = [],
): DirectMessageRequest[] {
  return acceptedRequestsInTurn(events, phase)
    .filter((request) =>
      request.source === "tell" &&
      request.initiator === "user" &&
      request.senderThreadId === null &&
      !request.texts.some((text) => managedPrompts.includes(text)),
    )
    .map(({ requestId, createdAt }) => ({ requestId, createdAt }));
}

export function managedPromptInTurn(
  events: readonly ThreadEvent[],
  phase: "active" | "completed",
  managedPrompts: readonly string[],
): boolean {
  return acceptedRequestsInTurn(events, phase).some((request) =>
    request.texts.some((text) => managedPrompts.includes(text)),
  );
}
