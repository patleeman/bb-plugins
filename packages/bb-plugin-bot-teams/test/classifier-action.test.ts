import test from "node:test";
import assert from "node:assert/strict";
import { classifierActionAnnotation } from "../classifier-action";

const bots = [
  { id: "bot_0123456789abcdef", name: "Atlas" },
  { id: "bot_1123456789abcdef", name: "Scribe" },
];

test("classifier annotation names the applied action and recipient", () => {
  assert.deepEqual(
    classifierActionAnnotation(
      [{ botId: bots[0]!.id, action: "steer" }],
      bots,
    ),
    {
      label: "Auto · Steer",
      description: "Classifier selected Steer for Atlas.",
    },
  );
  assert.deepEqual(
    classifierActionAnnotation(
      [
        { botId: bots[0]!.id, action: "followup", suggestedAction: "steer" },
        { botId: bots[1]!.id, action: "fork" },
      ],
      bots,
    ),
    {
      label: "Auto · 2 actions",
      description: "Classifier suggested Steer for Atlas; Bot Teams used Follow-up. Classifier selected Fork for Scribe.",
    },
  );
  assert.equal(classifierActionAnnotation(undefined, bots), null);
});
