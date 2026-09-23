import type { Bot, RoomMessage } from "./contract";
import { sendModeLabels } from "./send-mode";

export function classifierActionAnnotation(
  actions: RoomMessage["classifierActions"],
  bots: readonly Pick<Bot, "id" | "name">[],
) {
  if (!actions?.length) return null;
  const label = actions.length === 1
    ? `Auto · ${sendModeLabels[actions[0]!.action]}`
    : `Auto · ${actions.length} actions`;
  const description = actions.map(({ botId, action, suggestedAction }) => {
    const name = bots.find((bot) => bot.id === botId)?.name ?? "this bot";
    return suggestedAction
      ? `Classifier suggested ${sendModeLabels[suggestedAction]} for ${name}; Bot Teams used ${sendModeLabels[action]}.`
      : `Classifier selected ${sendModeLabels[action]} for ${name}.`;
  }).join(" ");
  return { label, description };
}
