import { z } from "zod";

/**
 * Every provider serves TypeSafe's System One protocol: POST `{ model, state,
 * questions }` with a bearer key, and receive `{ answers }`. Only the URL, key,
 * and model name differ. TypeSafe is the canonical provider; the others resell
 * the same model.
 */
export const jevPresets = {
  typesafe: {
    name: "TypeSafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    keySetting: "typesafeApiKey",
    keyEnv: "TYPESAFE_API_KEY",
  },
  vercel: {
    name: "Vercel AI Gateway",
    endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    model: "typesafe-ai/jev",
    keySetting: "vercelApiKey",
    keyEnv: "AI_GATEWAY_API_KEY",
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "typesafe/jev-1.13",
    keySetting: "openRouterApiKey",
    keyEnv: "OPENROUTER_API_KEY",
  },
  "opencode-zen": {
    name: "OpenCode Zen",
    endpoint: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13",
    keySetting: "zenApiKey",
    keyEnv: "OPENCODE_API_KEY",
  },
} as const;
export type JevPresetId = keyof typeof jevPresets;
export type JevProviderId = JevPresetId | "custom";
/** `auto` tries every configured provider in this order. */
export const jevProviderOrder: JevProviderId[] = ["typesafe", "vercel", "openrouter", "opencode-zen", "custom"];
export const jevProviderChoices = ["auto", ...jevProviderOrder] as const;

export type JevProviderSettings = {
  jevProvider?: string;
  typesafeApiKey?: string;
  typesafeModel?: string;
  vercelApiKey?: string;
  openRouterApiKey?: string;
  zenApiKey?: string;
  customJevEndpoint?: string;
  customJevApiKey?: string;
  customJevModel?: string;
};
export type JevRoute = {
  id: JevProviderId;
  name: string;
  endpoint: string;
  model: string;
  /** Null for a custom endpoint that takes no key. */
  apiKey: string | null;
};

const text = (value: string | undefined) => value?.trim() || "";

/**
 * A custom endpoint must use HTTPS so the key and conversation text are not
 * sent in the clear. Plain HTTP is allowed only to this machine.
 */
export function customEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The custom Jev endpoint is not a valid URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("The custom Jev endpoint must use HTTPS, or HTTP on localhost.");
  if (url.username || url.password) throw new Error("Put the custom Jev key in its own setting, not in the URL.");
  return url;
}

/**
 * The providers to try, in order. A preset needs a key from its setting or
 * its environment variable; a custom endpoint needs a URL and a model. A
 * misconfigured provider is skipped and reported, so it never blocks the
 * others that `auto` could still use.
 */
export function jevRoutes(
  settings: JevProviderSettings,
  env: NodeJS.ProcessEnv = process.env,
): { routes: JevRoute[]; problems: string[] } {
  const mode = z.enum(jevProviderChoices).catch("auto").parse(settings.jevProvider || "auto");
  const wanted = mode === "auto" ? jevProviderOrder : [mode];
  const routes: JevRoute[] = [];
  const problems: string[] = [];
  for (const id of wanted) {
    if (id === "custom") {
      const endpoint = text(settings.customJevEndpoint);
      const model = text(settings.customJevModel);
      if (!endpoint && !model && mode === "auto") continue;
      if (!endpoint || !model) {
        problems.push("A custom Jev provider needs both an endpoint URL and a model.");
        continue;
      }
      try {
        const url = customEndpoint(endpoint);
        routes.push({
          id,
          name: `Custom (${url.host})`,
          endpoint: url.href,
          model,
          apiKey: text(settings.customJevApiKey) || null,
        });
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    const preset = jevPresets[id];
    const apiKey = text(settings[preset.keySetting]) || text(env[preset.keyEnv]);
    if (!apiKey) {
      if (mode !== "auto") problems.push(`${preset.name} has no API key. Set ${preset.keySetting} or ${preset.keyEnv}.`);
      continue;
    }
    const model = id === "typesafe" ? text(settings.typesafeModel) || preset.model : preset.model;
    routes.push({ id, name: preset.name, endpoint: preset.endpoint, model, apiKey });
  }
  return { routes, problems };
}

export function describeHttpFailure(route: JevRoute, status: number) {
  if (status === 401 || status === 403) return `${route.name} rejected the API key (HTTP ${status}).`;
  if (status === 402) return `${route.name} says the account is out of credit (HTTP 402).`;
  if (status === 429 || status === 529) return `${route.name} rate-limited Jev (HTTP ${status}).`;
  return `${route.name} request failed (HTTP ${status}).`;
}
