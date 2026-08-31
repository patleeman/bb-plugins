import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDwarfStarChatMessages,
  completionPayloadSizeError,
  completeInputSchema,
  MAX_COMPLETION_REQUEST_BODY_BYTES,
  MAX_COMPLETION_TEXT_BYTES,
  MAX_INLINE_IMAGE_DATA_URI_BYTES,
} from "./request-payload.ts";

test("preserves ordered inline images in the OpenAI Chat payload", () => {
  const first = "data:image/png;base64,AAAA";
  const second = "data:image/jpeg;base64,BBBB";
  assert.deepEqual(
    buildDwarfStarChatMessages("Describe these images", "You are concise", [first, second]),
    [
      { role: "system", content: "You are concise" },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe these images" },
          { type: "image_url", image_url: { url: first } },
          { type: "image_url", image_url: { url: second } },
        ],
      },
    ],
  );
});

test("keeps the existing string content shape for text-only requests", () => {
  assert.deepEqual(
    buildDwarfStarChatMessages("Just text", undefined),
    [{ role: "user", content: "Just text" }],
  );
});

test("rejects oversized inline image data before sending a request", () => {
  const prefix = "data:image/png;base64,";
  const image = (bytes: number) => prefix + "A".repeat(bytes - prefix.length);

  assert.equal(
    completeInputSchema.safeParse({
      prompt: "Describe this",
      imageUrls: [image(MAX_INLINE_IMAGE_DATA_URI_BYTES + 1)],
    }).success,
    false,
  );
  assert.equal(
    completeInputSchema.safeParse({
      prompt: "Describe these",
      imageUrls: [
        image(MAX_INLINE_IMAGE_DATA_URI_BYTES),
        image(MAX_INLINE_IMAGE_DATA_URI_BYTES),
        prefix + "A",
      ],
    }).success,
    false,
  );
});

test("rejects incomplete inline image base64 groups", () => {
  assert.equal(
    completeInputSchema.safeParse({
      prompt: "Describe this",
      imageUrls: ["data:image/png;base64,A="],
    }).success,
    false,
  );
  assert.equal(
    completeInputSchema.safeParse({
      prompt: "Describe this",
      imageUrls: ["data:image/png;base64,AAA"],
    }).success,
    false,
  );
});

test("rejects oversized prompt and system text before sending a request", () => {
  const oversized = "x".repeat(MAX_COMPLETION_TEXT_BYTES + 1);
  assert.equal(
    completeInputSchema.safeParse({ prompt: oversized }).success,
    false,
  );
  assert.match(
    completionPayloadSizeError("ok", oversized) ?? "",
    /prompt and system text must be 8 MiB or smaller/i,
  );
});

test("rejects a request whose JSON escaping exceeds the body budget", () => {
  const prefix = "data:image/png;base64,";
  const imageBytes = 13 * 1024 * 1024;
  const imagePayloadBytes = imageBytes - prefix.length;
  const image =
    prefix + "A".repeat(imagePayloadBytes - (imagePayloadBytes % 4));
  const prompt = "\0".repeat(MAX_COMPLETION_TEXT_BYTES);
  const parsed = completeInputSchema.safeParse({ prompt, imageUrls: [image] });

  assert.equal(parsed.success, false);
  assert.match(
    parsed.error?.issues[0]?.message ?? "",
    /serialized completion request must be 60 MiB or smaller/i,
  );
  assert.ok(MAX_COMPLETION_REQUEST_BODY_BYTES < 64 * 1024 * 1024);
});
