import { describe, expect, it } from "vitest";
import { StudioHub, type HubSdk } from "./hub";

function plugin(id: string, patch: Record<string, unknown> = {}) {
  return { id, name: `Studio ${id}`, enabled: true, status: "running", statusDetail: null, version: "1.0.0", ...patch };
}

const kind = { id: "page", label: "Page", plural: "Pages", icon: "FileText", columns: [], actions: [], create: { mode: "rpc" as const }, canArchive: true, blurb: "" };
const item = (id: string) => ({
  id,
  kind: "page",
  title: id,
  icon: null,
  projectId: null,
  parentId: null,
  createdAt: 1,
  updatedAt: 2,
  updatedBy: null,
  preview: null,
  facts: [],
  badge: null,
  thumbnailUrl: null,
  href: `/plugins/pages/pages/${id}`,
  archived: false,
});

function fakeSdk(options: {
  plugins: ReturnType<typeof plugin>[];
  discovered?: string[];
  rpc: Record<string, (input: unknown) => unknown>;
}): HubSdk & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    plugins: {
      list: async () => ({ plugins: options.plugins }),
      experimental_discoverRpc: async () => (options.discovered ?? []).map((pluginId) => ({ pluginId })),
      callRpc: async ({ pluginId, method, input, outputSchema }) => {
        calls.push(`${pluginId}.${method}`);
        const handler = options.rpc[`${pluginId}.${method}`];
        if (!handler) throw Object.assign(new Error("Not found"), { status: 404 });
        return outputSchema.parse(await handler(input));
      },
    },
  };
}

describe("StudioHub", () => {
  it("lists suite plugins first, then discovered ones, skipping disabled plugins and itself", async () => {
    const sdk = fakeSdk({
      plugins: [plugin("zeta"), plugin("pages"), plugin("talk", { enabled: false }), plugin("studio")],
      discovered: ["zeta", "studio", "pages"],
      rpc: {
        "pages.studio_describe": () => ({ pluginId: "pages", version: 1, panel: "pages", kinds: [kind] }),
        "zeta.studio_describe": () => ({ pluginId: "zeta", version: 1, panel: null, kinds: [] }),
      },
    });
    const providers = await new StudioHub(sdk).providers();
    expect(providers.map((provider) => [provider.pluginId, provider.state])).toEqual([
      ["pages", "ready"],
      ["zeta", "ready"],
    ]);
  });

  it("names a suite plugin that predates Studio, and one that isn't running", async () => {
    const sdk = fakeSdk({ plugins: [plugin("pages"), plugin("talk", { status: "error", statusDetail: "Crashed" })], rpc: {} });
    const providers = await new StudioHub(sdk).providers();
    expect(providers).toMatchObject([
      { pluginId: "pages", state: "outdated", detail: "Update Studio pages to see its items in Studio." },
      { pluginId: "talk", state: "offline", detail: "Crashed" },
    ]);
  });

  it("tags items with their plugin and takes a failing provider offline", async () => {
    const sdk = fakeSdk({
      plugins: [plugin("pages"), plugin("talk")],
      rpc: {
        "pages.studio_describe": () => ({ pluginId: "pages", version: 1, panel: "pages", kinds: [kind] }),
        "pages.studio_list": () => ({ items: [item("pg_1")] }),
        "talk.studio_describe": () => ({ pluginId: "talk", version: 1, panel: "recordings", kinds: [] }),
        "talk.studio_list": () => {
          throw new Error("Database locked");
        },
      },
    });
    const overview = await new StudioHub(sdk).overview();
    expect(overview.items.map((entry) => `${entry.pluginId}:${entry.id}`)).toEqual(["pages:pg_1"]);
    expect(overview.providers[1]).toMatchObject({ pluginId: "talk", state: "offline", detail: "Database locked" });
  });

  it("names the providers that listed only some of their items", async () => {
    const sdk = fakeSdk({
      plugins: [plugin("pages"), plugin("talk")],
      rpc: {
        "pages.studio_describe": () => ({ pluginId: "pages", version: 1, panel: "pages", kinds: [kind] }),
        "pages.studio_list": () => ({ items: [item("pg_1")] }),
        "talk.studio_describe": () => ({ pluginId: "talk", version: 1, panel: "recordings", kinds: [] }),
        "talk.studio_list": () => ({ items: [], truncated: true }),
      },
    });
    expect([...(await new StudioHub(sdk).overview()).truncated]).toEqual(["talk"]);
  });

  it("describes each plugin version once", async () => {
    const sdk = fakeSdk({
      plugins: [plugin("pages")],
      rpc: { "pages.studio_describe": () => ({ pluginId: "pages", version: 1, panel: "pages", kinds: [kind] }) },
    });
    const hub = new StudioHub(sdk);
    await hub.providers();
    await hub.providers();
    expect(sdk.calls.filter((call) => call === "pages.studio_describe")).toHaveLength(1);
  });

  it("merges content search across providers as plugin-scoped keys", async () => {
    const sdk = fakeSdk({
      plugins: [plugin("pages"), plugin("talk")],
      rpc: {
        "pages.studio_describe": () => ({ pluginId: "pages", version: 1, panel: null, kinds: [] }),
        "pages.studio_search": () => ({ ids: ["pg_1", "pg_2"], snippets: { pg_1: "…the plan for…" } }),
        "talk.studio_describe": () => ({ pluginId: "talk", version: 1, panel: null, kinds: [] }),
        "talk.studio_search": () => {
          throw new Error("down");
        },
      },
    });
    expect(await new StudioHub(sdk).search("plan")).toEqual({ keys: ["pages:pg_1", "pages:pg_2"], snippets: { "pages:pg_1": "…the plan for…" } });
  });

  it("refuses to call itself", async () => {
    const hub = new StudioHub(fakeSdk({ plugins: [], rpc: {} }));
    await expect(hub.call("studio", "studio_list", null)).rejects.toThrow("Studio isn't a provider.");
  });
});
