import type { Bot, RoomMessage } from "./contract";
import { sendModeLabels } from "./send-mode";

export function classifierActionAnnotation(
  actions: RoomMessage["classifierActions"],
  bots: readonly Pick<Bot, "id" | "name">[],
  plan?: RoomMessage["classifierPlan"],
  sendMode: RoomMessage["sendMode"] = "auto",
) {
  if (!actions?.length && !plan) return null;
  const label = plan
    ? `${sendMode && sendMode !== "auto" ? "Smart" : "Auto"} · ${plan.executionMode === "parallel" ? "Parallel" : "Serialized"}`
    : actions?.length === 1
      ? `Auto · ${sendModeLabels[actions[0]!.action]}`
      : `Auto · ${actions?.length ?? 0} actions`;
  const name = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  const collaborators = plan?.collaboratorIds.map(name) ?? [];
  const collaboratorSummary = collaborators.length
    ? `${collaborators.join(", ")} ${plan?.executionMode === "parallel"
      ? collaborators.length === 1 ? "starts in parallel" : "start in parallel"
      : collaborators.length === 1 ? "waits for delegation" : "wait for delegation"}.`
    : "No collaborators.";
  const summary = plan
    ? plan.coordinatorId
      ? `${name(plan.coordinatorId)} coordinates and finalizes. ${collaboratorSummary} ${plan.source === "fallback" ? "Classifier unavailable; used the single explicit recipient." : ""}`
      : "Classifier selected no response."
    : "";
  const description = (actions ?? []).map(({ botId, action, suggestedAction }) => {
    const name = bots.find((bot) => bot.id === botId)?.name ?? "this bot";
    return suggestedAction
      ? `${sendMode && sendMode !== "auto" ? "Requested" : "Classifier suggested"} ${sendModeLabels[suggestedAction]} for ${name}; Bot Teams used ${sendModeLabels[action]}.`
      : `Classifier selected ${sendModeLabels[action]} for ${name}.`;
  }).join(" ");
  return { label, description: [summary.trim(), description].filter(Boolean).join(" ") };
}
