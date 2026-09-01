import { z } from "zod";

/** OpenAI Chat message shapes accepted by ds4-server's multimodal parser. */

export type DwarfStarContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type DwarfStarChatMessage = {
  role: "system" | "user";
  content: string | DwarfStarContentBlock[];
};

export type DwarfStarChatRequest = {
  model: string;
  messages: DwarfStarChatMessage[];
  max_tokens: number;
  stream: false;
  temperature?: number;
};

/** Keep native-tool image input well below ds4-server's 64 MiB HTTP limit. */
export const MAX_INLINE_IMAGE_DATA_URI_BYTES = 16 * 1024 * 1024;
export const MAX_INLINE_IMAGE_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** Keep text and JSON escaping overhead well below ds4-server's 64 MiB limit. */
export const MAX_COMPLETION_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_COMPLETION_CONTENT_BYTES = 40 * 1024 * 1024;
export const MAX_COMPLETION_REQUEST_BODY_BYTES = 60 * 1024 * 1024;

const SCHEMA_MODEL_ID = "deepseek-v4-flash";

const inlineImageDataUriSchema = z
  .string()
  .max(
    MAX_INLINE_IMAGE_DATA_URI_BYTES,
    "Each inline image data URI must be 16 MiB or smaller.",
  )
  .regex(
    /^data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/]+={0,2}$/,
    "Use an inline PNG or JPEG data URI.",
  )
  .refine(
    (value) => value.slice(value.indexOf(",") + 1).length % 4 === 0,
    "The inline image base64 payload must use complete 4-character groups.",
  );

/** Input contract shared by the RPC and native ds4_complete tool. */
export const completeInputSchema = z
  .object({
    prompt: z.string().min(1),
    system: z.string().optional(),
    maxTokens: z.number().int().min(1).max(16384).default(1024),
    temperature: z.number().min(0).max(2).optional(),
    imageUrls: z
      .array(inlineImageDataUriSchema)
      .max(16, "DwarfStar accepts at most 16 images per request.")
      .default([])
      .describe("Inline PNG/JPEG data URIs; requires a configured DwarfStar vision encoder."),
  })
  .superRefine((value, ctx) => {
    const contentSizeError = completionPayloadSizeError(
      value.prompt,
      value.system,
      value.imageUrls,
    );
    const sizeError =
      contentSizeError ??
      completionRequestBodySizeError(
        serializeDwarfStarChatRequest(
          buildDwarfStarChatRequest(
            SCHEMA_MODEL_ID,
            value.prompt,
            value.system,
            value.maxTokens,
            value.temperature,
            value.imageUrls,
          ),
        ),
      );
    if (sizeError) {
      ctx.addIssue({
        code: "custom",
        path: ["prompt"],
        message: sizeError,
      });
    }
  })
  .strict();

/** Validate the raw UTF-8 content budget before constructing a request body. */
export function completionPayloadSizeError(
  prompt: string,
  system: string | undefined,
  imageUrls: readonly string[] = [],
): string | null {
  const textBytes =
    Buffer.byteLength(prompt, "utf8") +
    (system ? Buffer.byteLength(system, "utf8") : 0);
  if (textBytes > MAX_COMPLETION_TEXT_BYTES) {
    return "The combined prompt and system text must be 8 MiB or smaller.";
  }
  const imageBytes = imageUrls.reduce(
    (total, imageUrl) => total + Buffer.byteLength(imageUrl, "utf8"),
    0,
  );
  if (imageBytes > MAX_INLINE_IMAGE_PAYLOAD_BYTES) {
    return "The combined inline image data must be 32 MiB or smaller.";
  }
  if (textBytes + imageBytes > MAX_COMPLETION_CONTENT_BYTES) {
    return "The combined prompt, system text, and inline image data must be 40 MiB or smaller.";
  }
  return null;
}

/** Build the exact OpenAI-compatible request sent to ds4-server. */
export function buildDwarfStarChatRequest(
  model: string,
  prompt: string,
  system: string | undefined,
  maxTokens: number,
  temperature: number | undefined,
  imageUrls: readonly string[] = [],
): DwarfStarChatRequest {
  return {
    model,
    messages: buildDwarfStarChatMessages(prompt, system, imageUrls),
    max_tokens: maxTokens,
    stream: false,
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

export function serializeDwarfStarChatRequest(
  request: DwarfStarChatRequest,
): string {
  return JSON.stringify(request);
}

/** Keep the serialized request below ds4-server's 64 MiB HTTP body limit. */
export function completionRequestBodySizeError(body: string): string | null {
  if (Buffer.byteLength(body, "utf8") > MAX_COMPLETION_REQUEST_BODY_BYTES) {
    return "The serialized completion request must be 60 MiB or smaller.";
  }
  return null;
}

/** Build a text-only or ordered text-plus-image user message for ds4-server. */
export function buildDwarfStarChatMessages(
  prompt: string,
  system: string | undefined,
  imageUrls: readonly string[] = [],
): DwarfStarChatMessage[] {
  const messages: DwarfStarChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({
    role: "user",
    content: imageUrls.length
      ? [
          { type: "text", text: prompt },
          ...imageUrls.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ]
      : prompt,
  });
  return messages;
}
