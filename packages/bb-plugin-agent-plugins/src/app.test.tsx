// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Agent Plugins settings", () => {
  it("provides a full-height scroll container for long plugin lists", async () => {
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => ({ plugins: [], skills: [], mcpServers: [], dataDir: "/tmp/bb" }),
        checkUpdates: () => ({ updates: [] }),
      } as never,
    });

    const main = await slot.findByRole("main", { name: "Agent Plugins" });
    expect(main.className).toContain("h-full");
    expect(main.className).toContain("overflow-y-auto");
  });

  it("renders per-skill and per-MCP switches and persists their changes", async () => {
    let snapshot = {
      plugins: [{
        id: "plugin-1",
        name: "Example Plugin",
        version: "1.0.0",
        specVersion: "1.0.0",
        sourceType: "path",
        sourceIntent: "path:/tmp/example-plugin",
        sourceResolved: null,
        status: "active",
        approval: "approved",
        lastError: null,
      }],
      skills: [{
        pluginId: "plugin-1",
        skillName: "research",
        status: "active",
        lastError: null,
        enabled: true,
      }],
      mcpServers: [{
        pluginId: "plugin-1",
        serverId: "docs",
        type: "stdio",
        status: "idle",
        lastError: null,
        approved: 0,
        enabled: true,
        configJson: JSON.stringify({ type: "stdio", command: "node" }),
      }],
      dataDir: "/tmp/bb",
    };
    const calls: Array<{ method: string; input: unknown }> = [];

    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        checkUpdates: () => ({ updates: [] }),
        setSkillEnabled: ({ id, skillName, enabled }: { id: string; skillName: string; enabled: boolean }) => {
          calls.push({ method: "setSkillEnabled", input: { id, skillName, enabled } });
          snapshot = {
            ...snapshot,
            skills: snapshot.skills.map((skill) => skill.skillName === skillName ? { ...skill, enabled, status: enabled ? "active" : "skipped" } : skill),
          };
          return { enabled, status: enabled ? "active" : "skipped", lastError: null };
        },
        setMcpEnabled: ({ id, serverId, enabled }: { id: string; serverId: string; enabled: boolean }) => {
          calls.push({ method: "setMcpEnabled", input: { id, serverId, enabled } });
          snapshot = {
            ...snapshot,
            mcpServers: snapshot.mcpServers.map((server) => server.serverId === serverId ? { ...server, enabled, status: enabled ? "idle" : "disabled" } : server),
          };
          return { enabled, status: enabled ? "idle" : "disabled", lastError: null };
        },
      } as never,
    });

    fireEvent.click(await slot.findByRole("button", { name: /Example Plugin/ }));
    const skillSwitch = await slot.findByRole("switch", { name: "Disable skill research" });
    const mcpSwitch = await slot.findByRole("switch", { name: "Disable MCP server docs" });
    expect(slot.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(slot.getByRole("heading", { name: "MCP servers" })).toBeTruthy();

    fireEvent.click(skillSwitch);
    await waitFor(() => expect(calls).toContainEqual({
      method: "setSkillEnabled",
      input: { id: "plugin-1", skillName: "research", enabled: false },
    }));
    await slot.findByRole("switch", { name: "Enable skill research" });

    fireEvent.click(mcpSwitch);
    await waitFor(() => expect(calls).toContainEqual({
      method: "setMcpEnabled",
      input: { id: "plugin-1", serverId: "docs", enabled: false },
    }));
    await slot.findByRole("switch", { name: "Enable MCP server docs" });
  });

  it("checks tracked sources and exposes a per-plugin update action", async () => {
    const snapshot = {
      plugins: [{
        id: "plugin-1", name: "Example Plugin", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "git", sourceIntent: "git:https://example.com/plugin.git", sourceResolved: "git:https://example.com/plugin.git@old",
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [],
      mcpServers: [],
      dataDir: "/tmp/bb",
    };
    const calls: Array<{ method: string; input: unknown }> = [];
    let available = true;
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        checkUpdates: (input: unknown) => {
          calls.push({ method: "checkUpdates", input });
          return {
            updates: [{
              id: "plugin-1", currentVersion: "1.0.0", latestVersion: "1.1.0", available,
              checkedAt: Date.now(), error: null,
            }],
          };
        },
        update: (input: unknown) => {
          calls.push({ method: "update", input });
          available = false;
          return { id: "plugin-1", name: "Example Plugin", version: "1.1.0" };
        },
      } as never,
    });

    const updateButton = await slot.findByRole("button", { name: "Update Example Plugin to version 1.1.0" });
    expect(slot.getByText("Update available · v1.1.0")).toBeTruthy();
    fireEvent.click(updateButton);
    await waitFor(() => expect(calls).toContainEqual({ method: "update", input: { id: "plugin-1" } }));
    await waitFor(() => expect(calls).toContainEqual({ method: "checkUpdates", input: { id: "plugin-1" } }));
  });

  it("ignores an older snapshot response after a newer realtime refresh", async () => {
    const enabledSnapshot = {
      plugins: [{
        id: "plugin-1", name: "Example Plugin", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/example-plugin", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [{ pluginId: "plugin-1", skillName: "research", status: "active", lastError: null, enabled: true }],
      mcpServers: [],
      dataDir: "/tmp/bb",
    };
    const disabledSnapshot = {
      ...enabledSnapshot,
      skills: [{ ...enabledSnapshot.skills[0]!, status: "skipped", enabled: false }],
    };
    const pending: Array<(value: typeof enabledSnapshot) => void> = [];
    let snapshotCalls = 0;
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => {
          snapshotCalls += 1;
          return new Promise<typeof enabledSnapshot>((resolve) => pending.push(resolve));
        },
        checkUpdates: () => ({ updates: [] }),
      } as never,
    });

    await waitFor(() => expect(snapshotCalls).toBe(1));
    await slot.emitRealtime("agent-plugins-changed", { kind: "toggle" });
    await waitFor(() => expect(snapshotCalls).toBe(2));

    pending[1]!(disabledSnapshot);
    const pluginButton = await slot.findByRole("button", { name: /Example Plugin/ });
    fireEvent.click(pluginButton);
    await slot.findByRole("switch", { name: "Enable skill research" });

    pending[0]!(enabledSnapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.getByRole("switch", { name: "Enable skill research" })).toBeTruthy();
    expect(slot.queryByRole("switch", { name: "Disable skill research" })).toBeNull();
  });

  it("opens the SDK-managed OAuth flow for an authenticated HTTP server", async () => {
    const snapshot = {
      plugins: [{
        id: "plugin-1", name: "OAuth Plugin", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/oauth-plugin", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [],
      mcpServers: [{
        pluginId: "plugin-1", serverId: "fastmail", type: "streamable-http", status: "needs-auth",
        lastError: "Authentication required", approved: 1, enabled: true,
        configJson: JSON.stringify({ type: "streamable-http", url: "https://example.com/mcp" }),
      }],
      dataDir: "/tmp/bb",
    };
    const calls: unknown[] = [];
    const authWindow = {
      opener: window,
      location: { href: "about:blank" },
      close: vi.fn(),
    } as unknown as Window;
    const opened = vi.spyOn(window, "open").mockReturnValue(authWindow);
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        checkUpdates: () => ({ updates: [] }),
        authenticate: (input: unknown) => {
          calls.push(input);
          return { url: "https://example.com/authorize?state=test", status: "authorizing" };
        },
      } as never,
    });

    fireEvent.click(await slot.findByRole("button", { name: /OAuth Plugin/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Authenticate fastmail" }));
    await waitFor(() => expect(calls).toEqual([{ id: "plugin-1", serverId: "fastmail" }]));
    expect(opened).toHaveBeenNthCalledWith(1, "about:blank", "_blank");
    expect(authWindow.location.href).toBe("https://example.com/authorize?state=test");
  });

  it("offers reconnect instead of authenticate after an update leaves an authenticated server idle", async () => {
    const snapshot = {
      plugins: [{
        id: "plugin-1", name: "OAuth Plugin", version: "1.1.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/oauth-plugin", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [],
      mcpServers: [{
        pluginId: "plugin-1", serverId: "fastmail", type: "streamable-http", status: "idle",
        authStatus: "authenticated", lastError: null, approved: 1, enabled: true,
        configJson: JSON.stringify({ type: "streamable-http", url: "https://example.com/mcp" }),
      }],
      dataDir: "/tmp/bb",
    };
    const calls: unknown[] = [];
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        checkUpdates: () => ({ updates: [] }),
        reconnect: (input: unknown) => { calls.push(input); return { status: "ready", lastError: null }; },
      } as never,
    });

    fireEvent.click(await slot.findByRole("button", { name: /OAuth Plugin/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Reconnect fastmail" }));
    await waitFor(() => expect(calls).toEqual([{ id: "plugin-1", serverId: "fastmail" }]));
  });

  it("shows a toast when an OAuth action fails", async () => {
    const errorToast = vi.spyOn(toast, "error");
    const authWindow = {
      opener: window,
      location: { href: "about:blank" },
      close: vi.fn(),
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(authWindow);
    const snapshot = {
      plugins: [{
        id: "plugin-1", name: "OAuth Plugin", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/oauth-plugin", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [],
      mcpServers: [{
        pluginId: "plugin-1", serverId: "fastmail", type: "streamable-http", status: "needs-auth",
        authStatus: "unauthenticated", lastError: "Authentication required", approved: 1, enabled: true,
        configJson: JSON.stringify({ type: "streamable-http", url: "https://example.com/mcp" }),
      }],
      dataDir: "/tmp/bb",
    };
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        checkUpdates: () => ({ updates: [] }),
        authenticate: () => { throw new Error("OAuth token exchange timed out"); },
      } as never,
    });

    fireEvent.click(await slot.findByRole("button", { name: /OAuth Plugin/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Authenticate fastmail" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(
      "OAuth token exchange timed out",
      expect.objectContaining({ id: "agent-plugins:mcp-auth:plugin-1:fastmail:error" }),
    ));
  });

  it("notifies when a delayed OAuth callback changes server state to failed", async () => {
    const errorToast = vi.spyOn(toast, "error");
    let snapshot = {
      plugins: [{
        id: "plugin-1", name: "OAuth Plugin", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/oauth-plugin", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [],
      mcpServers: [{
        pluginId: "plugin-1", serverId: "fastmail", type: "streamable-http", status: "needs-auth",
        authStatus: "authorizing", lastError: null as string | null, approved: 1, enabled: true,
        configJson: JSON.stringify({ type: "streamable-http", url: "https://example.com/mcp" }),
      }],
      dataDir: "/tmp/bb",
    };
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: { snapshot: () => snapshot, checkUpdates: () => ({ updates: [] }) } as never,
    });

    await slot.findByRole("button", { name: /OAuth Plugin/ });
    expect(errorToast).not.toHaveBeenCalled();
    snapshot = {
      ...snapshot,
      mcpServers: [{
        ...snapshot.mcpServers[0]!,
        authStatus: "unauthenticated",
        lastError: "OAuth token exchange timed out",
      }],
    };
    await slot.emitRealtime("agent-plugins-changed", { kind: "oauth-failed" });
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(
      "fastmail: OAuth token exchange timed out",
      expect.objectContaining({ id: "mcp:plugin-1:fastmail:error" }),
    ));
  });

  it("supports reconnect, forced reauthorization, and local disconnect", async () => {
    let snapshot = {
      plugins: [{
        id: "plugin-1", name: "OAuth Plugin", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/oauth-plugin", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [],
      mcpServers: [{
        pluginId: "plugin-1", serverId: "fastmail", type: "streamable-http", status: "ready",
        authStatus: "authenticated", lastError: null, approved: 1, enabled: true,
        configJson: JSON.stringify({ type: "streamable-http", url: "https://example.com/mcp" }),
      }],
      dataDir: "/tmp/bb",
    };
    const calls: Array<{ method: string; input: unknown }> = [];
    const authWindow = {
      opener: window,
      location: { href: "about:blank" },
      close: vi.fn(),
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(authWindow);

    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        checkUpdates: () => ({ updates: [] }),
        reconnect: (input: unknown) => {
          calls.push({ method: "reconnect", input });
          return { url: null, status: "authenticated" };
        },
        reauthorize: (input: unknown) => {
          calls.push({ method: "reauthorize", input });
          snapshot = {
            ...snapshot,
            mcpServers: [{ ...snapshot.mcpServers[0]!, status: "needs-auth", authStatus: "authorizing" }],
          };
          return { url: "https://example.com/authorize?state=fresh", status: "authorizing" };
        },
        clearAuthentication: (input: unknown) => {
          calls.push({ method: "clearAuthentication", input });
          snapshot = {
            ...snapshot,
            mcpServers: [{ ...snapshot.mcpServers[0]!, status: "idle", authStatus: "unauthenticated" }],
          };
          return { cleared: true };
        },
      } as never,
    });

    fireEvent.click(await slot.findByRole("button", { name: /OAuth Plugin/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Reconnect fastmail" }));
    await waitFor(() => expect(calls).toContainEqual({
      method: "reconnect",
      input: { id: "plugin-1", serverId: "fastmail" },
    }));
    expect(authWindow.close).toHaveBeenCalled();

    fireEvent.click(await slot.findByRole("button", { name: "Reauthorize" }));
    await waitFor(() => expect(calls).toContainEqual({
      method: "reauthorize",
      input: { id: "plugin-1", serverId: "fastmail" },
    }));
    expect(authWindow.location.href).toBe("https://example.com/authorize?state=fresh");

    fireEvent.click(await slot.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls).toContainEqual({
      method: "clearAuthentication",
      input: { id: "plugin-1", serverId: "fastmail" },
    }));
    await slot.findByRole("button", { name: "Authenticate fastmail" });
  });

  it("finishes remote sign-in with a pasted localhost callback without showing the code in a message", async () => {
    const callbackUrl = "http://localhost:38886/api/v1/plugins/agent-plugins/http/oauth/callback?pluginId=plugin-1&serverId=fastmail&code=one-use-secret&state=nonce";
    let snapshot = {
      plugins: [{
        id: "plugin-1", name: "Fastmail", version: "1.0.0", specVersion: "1.0.0",
        sourceType: "path", sourceIntent: "path:/tmp/fastmail", sourceResolved: null,
        status: "active", approval: "approved", lastError: null,
      }],
      skills: [],
      mcpServers: [{
        pluginId: "plugin-1", serverId: "fastmail", type: "streamable-http", status: "needs-auth",
        authStatus: "authorizing", lastError: null as string | null, approved: 1, enabled: true,
        configJson: JSON.stringify({ type: "streamable-http", url: "https://api.fastmail.com/mcp" }),
      }],
      dataDir: "/tmp/bb",
    };
    const calls: unknown[] = [];
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => snapshot,
        checkUpdates: () => ({ updates: [] }),
        finishAuthentication: (input: unknown) => {
          calls.push(input);
          snapshot = { ...snapshot, mcpServers: [{ ...snapshot.mcpServers[0]!, status: "ready", authStatus: "authenticated" }] };
          return { authenticated: true };
        },
      } as never,
    });

    fireEvent.click(await slot.findByRole("button", { name: /Fastmail/ }));
    const field = await slot.findByRole("textbox", { name: "Callback URL for fastmail" });
    fireEvent.change(field, { target: { value: callbackUrl } });
    fireEvent.click(slot.getByRole("button", { name: "Finish sign-in" }));
    await waitFor(() => expect(calls).toEqual([{ id: "plugin-1", serverId: "fastmail", callbackUrl }]));
    await waitFor(() => expect(slot.queryByRole("textbox", { name: "Callback URL for fastmail" })).toBeNull());
    expect(slot.queryByText(/one-use-secret/)).toBeNull();
  });
});
