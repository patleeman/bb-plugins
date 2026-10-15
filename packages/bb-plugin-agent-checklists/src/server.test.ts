import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import type { Checklist } from "./types";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const templateIds = new WeakMap<object, { research: string; softwareDelivery: string }>();

type TestHost = ReturnType<typeof createFakePluginHost>;

function createHost(settings?: Record<string, string>) {
  const host = createFakePluginHost({
    pluginId: "agent-checklists",
    settings,
    sdk: {
      threads: {
        send: async () => ({ ok: true }),
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }),
      },
    },
  });
  hosts.push(host);
  return host;
}

async function startHost(
  settings?: Record<string, string>,
  configure?: (host: ReturnType<typeof createFakePluginHost>) => void,
) {
  const host = createHost(settings);
  configure?.(host);
  await plugin(host.bb);
  const research = (await host.harness.callRpc("saveTemplate", {
    name: "Research to technical document",
    description: "Turn research into a clear document.",
    defaultMode: "approval",
    steps: Array.from({ length: 8 }, (_, index) => ({
      title: `Research step ${index + 1}`,
      description: "",
    })),
  })) as { id: string };
  const softwareDelivery = (await host.harness.callRpc("saveTemplate", {
    name: "Software delivery",
    description: "Carry a coding task through handoff.",
    defaultMode: "automatic",
    steps: Array.from({ length: 8 }, (_, index) => ({
      title: `Delivery step ${index + 1}`,
      description: "",
    })),
  })) as { id: string };
  templateIds.set(host, { research: research.id, softwareDelivery: softwareDelivery.id });
  return host;
}

function softwareTemplateId(host: TestHost): string {
  const ids = templateIds.get(host);
  if (!ids) throw new Error("Missing test template IDs");
  return ids.softwareDelivery;
}

function researchTemplateId(host: TestHost): string {
  const ids = templateIds.get(host);
  if (!ids) throw new Error("Missing test template IDs");
  return ids.research;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("Checklists server", () => {
  it("does not seed reusable Checklists", async () => {
    const host = createHost();
    await plugin(host.bb);

    const result = (await host.harness.callRpc("listTemplates", null)) as {
      templates: unknown[];
    };
    expect(result.templates).toEqual([]);
    expect(host.harness.registrations.rpcMethods).not.toContain("updateStep");
    expect(host.harness.registrations.rpcMethods).not.toContain("addNote");
  });

  it("attaches a template, exposes agent tools, and updates a step", async () => {
    const host = await startHost();

    const templates = (await host.harness.callRpc("listTemplates", null)) as {
      templates: Array<{ id: string }>;
    };
    const template = templates.templates.find((entry) => entry.id === softwareTemplateId(host));
    expect(template).toBeDefined();

    const checklist = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;
    expect(checklist).toMatchObject({ threadId: "thread-1", continuationMode: "automatic" });

    const toolResult = await host.harness.callAgentTool("agent_checklist_get", {}, {
      threadId: "thread-1",
      projectId: "project-1",
    });
    expect(JSON.stringify(toolResult)).toContain("Software delivery");

    const step = checklist.steps[0]!;
    const updated = await host.harness.callAgentTool(
      "agent_checklist_update",
      { stepId: step.id, checked: true, note: "Confirmed." },
      { threadId: "thread-1", projectId: "project-1" },
    );
    expect(updated).toContain('"checked":true');
  });

  it("starts a new automatic continuation after agent progress", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));

    await host.harness.callAgentTool(
      "agent_checklist_update",
      { stepId: attached.steps[0]!.id, checked: true },
      { threadId: "thread-1", projectId: "project-1" },
    );
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(2));
  });

  it("requires a step ID for checkbox updates and rejects no-op step updates", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;

    await expect(
      host.harness.callAgentTool(
        "agent_checklist_update",
        { checked: true, note: "Done." },
        { threadId: "thread-1", projectId: "project-1" },
      ),
    ).rejects.toThrow("step ID");
    await expect(
      host.harness.callAgentTool(
        "agent_checklist_update",
        { stepId: attached.steps[0]!.id },
        { threadId: "thread-1", projectId: "project-1" },
      ),
    ).rejects.toThrow("checkbox, note, or evidence");

    const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist;
    };
    expect(current.checklist.steps[0]?.checked).toBe(false);
    expect(current.checklist.notes).toHaveLength(0);
  });

  it("round trips the Checklist picker and cancellation through the host interaction", async () => {
    const host = await startHost();
    const picking = host.harness.callRpc("pickTemplate", { threadId: "thread-1" });
    await vi.waitFor(() => expect(host.harness.pendingInteractions).toHaveLength(1));
    const interaction = host.harness.pendingInteractions[0]!;
    expect(interaction).toMatchObject({
      rendererId: "agent-checklist-picker",
      title: "Checklist",
      threadId: "thread-1",
    });
    host.harness.submitInteraction(interaction.id, { templateId: researchTemplateId(host) });
    await expect(picking).resolves.toEqual({ templateId: researchTemplateId(host) });

    const cancelled = host.harness.callRpc("pickTemplate", { threadId: "thread-1" });
    await vi.waitFor(() => expect(host.harness.pendingInteractions).toHaveLength(1));
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);
    await expect(cancelled).resolves.toEqual({ templateId: null });
  });

  it("requires explicit detach before attaching a replacement", async () => {
    const host = await startHost();
    const first = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;

    await expect(
      host.harness.callRpc("attach", {
        threadId: "thread-1",
        templateId: researchTemplateId(host),
      }),
    ).rejects.toThrow("Detach the current Checklist before attaching another");

    await expect(host.harness.callRpc("detach", { checklistId: first.id })).resolves.toEqual({
      detached: true,
    });
    const replacement = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
        templateId: researchTemplateId(host),
    })) as Checklist;
    expect(replacement.name).toBe("Research to technical document");
  });

  it("closes an attached lifecycle and prevents future continuation", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;

    const closed = (await host.harness.callRpc("close", { checklistId: attached.id })) as Checklist;
    expect(closed).toMatchObject({ id: attached.id, status: "closed" });
    expect(
      (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      },
    ).toMatchObject({ checklist: { id: attached.id, status: "closed" } });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "The thread is idle.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("rejects continuing a closed lifecycle", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;

    await host.harness.callRpc("close", { checklistId: attached.id });

    await expect(host.harness.callRpc("continue", { checklistId: attached.id })).rejects.toThrow(
      "This Checklist is closed",
    );
  });

  it("persists custom templates through the authoring RPCs", async () => {
    const host = await startHost();

    const created = (await host.harness.callRpc("saveTemplate", {
      name: "Release workflow",
      description: "Ship safely.",
      defaultMode: "approval",
      steps: [{ title: "Run checks", description: "Run the test suite." }],
    })) as {
      id: string;
      name: string;
      updatedAt: number;
      steps: Array<{ title: string }>;
    };
    expect(created).toMatchObject({ name: "Release workflow" });
    expect(created.steps[0]?.title).toBe("Run checks");

    const edited = (await host.harness.callRpc("saveTemplate", {
      templateId: created.id,
      expectedUpdatedAt: created.updatedAt,
      name: "Release todo",
      description: "A short release reminder.",
      defaultMode: "tracking",
      steps: [
        { title: "Run checks", description: "Run the test suite." },
        { title: "Share the result", description: "Write the handoff." },
      ],
    })) as { name: string; updatedAt: number; steps: Array<unknown> };
    expect(edited).toMatchObject({ name: "Release todo" });
    expect(edited.steps).toHaveLength(2);

    await expect(
      host.harness.callRpc("saveTemplate", {
        templateId: created.id,
        expectedUpdatedAt: created.updatedAt,
        name: "Stale release",
        description: "This must not replace the newer edit.",
        defaultMode: "automatic",
        steps: [{ title: "Stale step", description: "No-op." }],
      }),
    ).rejects.toThrow("changed elsewhere");

    await expect(
      host.harness.callRpc("deleteTemplate", {
        templateId: created.id,
        expectedUpdatedAt: created.updatedAt,
      }),
    ).rejects.toThrow("changed elsewhere");
    await host.harness.callRpc("deleteTemplate", {
      templateId: created.id,
      expectedUpdatedAt: edited.updatedAt,
    });
    const templates = (await host.harness.callRpc("listTemplates", null)) as {
      templates: Array<{ id: string }>;
    };
    expect(templates.templates.some((template) => template.id === created.id)).toBe(false);
  });

  it("continues an automatic checklist after thread idle", async () => {
    const host = await startHost();
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    const sent = host.harness.sdk.callsTo("threads.send")[0]?.[0] as
      | {
          threadId?: string;
          mode?: string;
          input?: Array<{ type?: string; visibility?: string; text?: string }>;
        }
      | undefined;
    expect(sent).toMatchObject({
      threadId: "thread-1",
      mode: "auto",
      input: [expect.objectContaining({ type: "text", visibility: "agent-only" })],
    });
    const notice = (sent?.input?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(notice).toContain("Checklist continuation");
    expect(notice).toContain(
      'BB resumed this thread because the attached Checklist "Software delivery" is still incomplete (0 of 8 steps complete; 8 remaining).',
    );
    expect(notice).toContain('Continue the current task from the next unchecked step: "Delivery step 1".');
    expect(notice).toContain("Call agent_checklist_get");
    expect(notice).toContain("call agent_checklist_update with checked: true");
  });

  it("does not send a reminder after the continuation cap is reached", async () => {
    const host = await startHost({ maxContinuations: "1" });
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    });

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist | null;
    };
    expect(current.checklist).toMatchObject({ status: "limit_reached", continuationCount: 1 });
  });

  it("serializes overlapping idle continuations for one checklist", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.send", () => sendPromise);
    });
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    });

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    resolveSend?.({ ok: true });
  });

  it("does not redeliver after pausing and resuming during an in-flight send", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.send", () => sendPromise);
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      status: "paused",
    });
    const resuming = host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      status: "active",
    });
    resolveSend?.({ ok: true });

    await expect(resuming).resolves.toMatchObject({ status: "active", continuationCount: 1 });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("resumes a capped checklist through the explicit resume RPC", async () => {
    const host = await startHost({ maxContinuations: "1" });
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    });

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);

    const resumed = (await host.harness.callRpc("resume", {
      checklistId: ((await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      }).checklist.id,
    })) as Checklist;
    expect(resumed).toMatchObject({ status: "active", continuationCount: 1 });
  });

  it("resumes a capped checklist and continues immediately when the thread is idle", async () => {
    const host = await startHost({ maxContinuations: "1" }, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      );
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    const idle = {
      thread: makeThreadResponse({ id: "thread-1", status: "idle" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist.status).toBe("limit_reached");
    });

    const resumed = (await host.harness.callRpc("resume", { checklistId: attached.id })) as Checklist;
    expect(resumed).toMatchObject({ status: "active", continuationCount: 1 });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(2);
  });

  it("resumes an approval checklist to an approval prompt when the thread is idle", async () => {
    const host = await startHost({ maxContinuations: "1" }, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      );
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
        templateId: researchTemplateId(host),
      continuationMode: "approval",
    })) as Checklist;
    const idle = {
      thread: makeThreadResponse({ id: "thread-1", status: "idle" }),
      lastAssistantText: "I stopped early.",
    };

    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist.status).toBe("awaiting_approval");
    });
    await host.harness.callRpc("continue", { checklistId: attached.id });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist.status).toBe("limit_reached");
    });

    const limited = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist;
    };
    expect(limited.checklist).toMatchObject({ status: "limit_reached", continuationMode: "approval" });

    const resumed = (await host.harness.callRpc("resume", { checklistId: attached.id })) as Checklist;
    expect(resumed).toMatchObject({ status: "awaiting_approval", continuationCount: 0 });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("marks approval mode as waiting without sending", async () => {
    const host = await startHost();
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
        templateId: researchTemplateId(host),
      continuationMode: "approval",
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "Ready for review.",
    });

    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
    const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist | null;
    };
    expect(current.checklist?.status).toBe("awaiting_approval");
  });

  it("does not manually continue after switching away from approval mode", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
        templateId: researchTemplateId(host),
      continuationMode: "approval",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "Ready for review.",
    });
    const changed = (await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      continuationMode: "tracking",
    })) as Checklist;
    expect(changed).toMatchObject({ status: "active", continuationMode: "tracking" });

    const continued = (await host.harness.callRpc("continue", { checklistId: attached.id })) as {
      sent: boolean;
      checklist: Checklist | null;
    };
    expect(continued).toEqual({ sent: false, checklist: null });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("does not lose the first approval after switching modes during validation", async () => {
    let getCount = 0;
    let resolveAutomaticValidation: ((value: ReturnType<typeof makeThreadResponse>) => void) | undefined;
    const automaticValidation = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      resolveAutomaticValidation = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) => {
        getCount += 1;
        if (getCount === 1) return makeThreadResponse({ id: threadId, status: "active" });
        if (getCount === 2) return automaticValidation;
        return makeThreadResponse({ id: threadId, status: "idle" });
      });
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(getCount).toBe(2));
    const switching = host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      continuationMode: "approval",
    });
    await vi.waitFor(() => expect(getCount).toBe(3));
    resolveAutomaticValidation?.(makeThreadResponse({ id: "thread-1", status: "idle" }));
    await expect(switching).resolves.toMatchObject({ status: "awaiting_approval" });

    const approving = host.harness.callRpc("continue", { checklistId: attached.id });
    await expect(approving).resolves.toMatchObject({ sent: true });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("does not create an approval prompt after an in-flight automatic reminder delivered", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.send", () => sendPromise);
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    const switching = host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      continuationMode: "approval",
    });
    resolveSend?.({ ok: true });

    await expect(switching).resolves.toMatchObject({
      status: "active",
      continuationMode: "approval",
    });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("allows an already-issued reminder to finish after closing", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.send", () => sendPromise);
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));

    const closed = (await host.harness.callRpc("close", { checklistId: attached.id })) as Checklist;
    expect(closed).toMatchObject({ status: "closed", continuationCount: 1 });
    resolveSend?.({ ok: true });

    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist).toMatchObject({ status: "closed", continuationCount: 1 });
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "The reminder finished.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("restores approval waiting state when a manual continuation meets a busy thread", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: researchTemplateId(host),
      continuationMode: "approval",
    })) as Checklist;
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "Ready for review.",
    });
    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist.status).toBe("awaiting_approval");
    });
    host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: "active" }),
    );

    const result = (await host.harness.callRpc("continue", { checklistId: attached.id })) as {
      sent: boolean;
      checklist: Checklist;
    };
    expect(result).toMatchObject({ sent: false, checklist: { status: "awaiting_approval", continuationCount: 0 } });
  });

  it("retries a failed reminder without consuming the continuation cap", async () => {
    let sendCount = 0;
    const host = await startHost({ maxContinuations: "1" }, (candidate) => {
      candidate.harness.sdk.stub("threads.send", async () => {
        sendCount += 1;
        if (sendCount === 1) throw new Error("send unavailable");
        return { ok: true };
      });
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    const idle = {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    };
    await host.harness.behavior.emitThreadEvent("thread.idle", idle);
    await vi.waitFor(async () => {
      expect(sendCount).toBe(1);
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist | null;
      };
      expect(current.checklist).toMatchObject({ status: "paused", continuationCount: 0 });
    });

    await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      status: "active",
    });
    await vi.waitFor(async () => {
      expect(sendCount).toBe(2);
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist | null;
      };
      expect(current.checklist).toMatchObject({ status: "active", continuationCount: 1 });
    });
  });

  it("continues immediately when automatic mode is enabled on an idle thread", async () => {
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, status: "idle" }),
      );
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "tracking",
    })) as Checklist;

    const updated = (await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      continuationMode: "automatic",
    })) as Checklist;
    expect(updated).toMatchObject({ continuationMode: "automatic", continuationCount: 1 });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("does not send a stale reminder after pausing during pre-send validation", async () => {
    let getCount = 0;
    let resolveValidation: ((value: ReturnType<typeof makeThreadResponse>) => void) | undefined;
    const validation = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      resolveValidation = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) => {
        getCount += 1;
        if (getCount === 1) return makeThreadResponse({ id: threadId, status: "active" });
        return validation;
      });
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(getCount).toBe(2));
    await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      status: "paused",
    });
    resolveValidation?.(makeThreadResponse({ id: "thread-1", status: "idle" }));

    await vi.waitFor(async () => {
      expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist).toMatchObject({ status: "paused", continuationCount: 0 });
    });
  });

  it("invalidates an in-flight continuation when the lifecycle is closed", async () => {
    let getCount = 0;
    let resolveValidation: ((value: ReturnType<typeof makeThreadResponse>) => void) | undefined;
    const validation = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      resolveValidation = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) => {
        getCount += 1;
        if (getCount === 1) return makeThreadResponse({ id: threadId, status: "idle" });
        return validation;
      });
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(getCount).toBe(2));
    const closed = (await host.harness.callRpc("close", { checklistId: attached.id })) as Checklist;
    expect(closed.status).toBe("closed");
    resolveValidation?.(makeThreadResponse({ id: "thread-1", status: "idle" }));

    await vi.waitFor(async () => {
      expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist).toMatchObject({ status: "closed", continuationCount: 0 });
    });
  });

  it("retries continuation after resuming during pre-send validation", async () => {
    let getCount = 0;
    let resolveValidation: ((value: ReturnType<typeof makeThreadResponse>) => void) | undefined;
    const validation = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      resolveValidation = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) => {
        getCount += 1;
        if (getCount === 1) return makeThreadResponse({ id: threadId, status: "active" });
        return validation;
      });
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(getCount).toBe(2));
    await host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      status: "paused",
    });
    const resuming = host.harness.callRpc("updateSettings", {
      checklistId: attached.id,
      status: "active",
    });
    await vi.waitFor(() => expect(getCount).toBe(3));
    resolveValidation?.(makeThreadResponse({ id: "thread-1", status: "idle" }));

    await expect(resuming).resolves.toMatchObject({
      status: "active",
      continuationCount: 1,
    });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("does not send a reminder after the thread becomes active during validation", async () => {
    let getCount = 0;
    let resolveValidation: ((value: ReturnType<typeof makeThreadResponse>) => void) | undefined;
    const validation = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      resolveValidation = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) => {
        getCount += 1;
        if (getCount === 1) return makeThreadResponse({ id: threadId, status: "idle" });
        return validation;
      });
    });
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1", status: "idle" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(getCount).toBe(2));
    resolveValidation?.(makeThreadResponse({ id: "thread-1", status: "active" }));

    await vi.waitFor(async () => {
      expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist;
      };
      expect(current.checklist).toMatchObject({
        id: attached.id,
        status: "active",
        continuationCount: 0,
      });
    });
  });

  it("rejects attaching a checklist to an archived thread", async () => {
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", async ({ threadId }) =>
        makeThreadResponse({ id: threadId, archivedAt: 1 }),
      );
    });

    await expect(
      host.harness.callRpc("attach", {
        threadId: "thread-archived",
        templateId: softwareTemplateId(host),
      }),
    ).rejects.toThrow("archived or deleted");
  });

  it("rejects an attachment if the thread is archived during the final lookup", async () => {
    let resolveThread: ((thread: ReturnType<typeof makeThreadResponse>) => void) | undefined;
    const threadPromise = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
      resolveThread = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.get", () => threadPromise);
    });

    const attaching = host.harness.callRpc("attach", {
      threadId: "thread-racing-archive",
      templateId: softwareTemplateId(host),
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.get")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-racing-archive", archivedAt: 1 }),
    });
    resolveThread?.(makeThreadResponse({ id: "thread-racing-archive", status: "active" }));

    await expect(attaching).rejects.toThrow("archived or deleted");
    const current = (await host.harness.callRpc("getForThread", {
      threadId: "thread-racing-archive",
    })) as { checklist: Checklist | null };
    expect(current.checklist).toBeNull();
  });

  it("keeps an in-flight continuation unavailable after the thread is archived", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.send", () => sendPromise);
    });
    await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    await host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-1", archivedAt: 1 }),
    });
    resolveSend?.({ ok: true });

    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist | null;
      };
      expect(current.checklist).toMatchObject({ status: "orphaned" });
    });
  });

  it("does not orphan a replacement checklist when a detached send resolves", async () => {
    let resolveSend: ((value: { ok: true }) => void) | undefined;
    const sendPromise = new Promise<{ ok: true }>((resolve) => {
      resolveSend = resolve;
    });
    const host = await startHost(undefined, (candidate) => {
      candidate.harness.sdk.stub("threads.send", () => sendPromise);
    });
    const first = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
      continuationMode: "automatic",
    })) as Checklist;

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1" }),
      lastAssistantText: "I stopped early.",
    });
    await vi.waitFor(() => expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1));
    const detaching = host.harness.callRpc("detach", { checklistId: first.id });
    await Promise.resolve();
    resolveSend?.({ ok: true });
    await detaching;
    const replacement = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
        templateId: researchTemplateId(host),
    })) as Checklist;

    await vi.waitFor(async () => {
      const current = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
        checklist: Checklist | null;
      };
      expect(current.checklist).toMatchObject({ id: replacement.id, status: "active" });
    });
  });

  it("does not partially commit a conflicting compound agent update", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;
    for (const step of attached.steps.slice(0, -1)) {
      await host.harness.callAgentTool(
        "agent_checklist_update",
        { stepId: step.id, checked: true },
        { threadId: "thread-1", projectId: "project-1" },
      );
    }
    const before = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist;
    };
    const lastStep = before.checklist.steps.at(-1)!;

    await expect(
      host.harness.callAgentTool(
        "agent_checklist_update",
        { stepId: lastStep.id, checked: true, status: "active" },
        { threadId: "thread-1", projectId: "project-1" },
      ),
    ).rejects.toThrow("completed Checklist");

    const after = (await host.harness.callRpc("getForThread", { threadId: "thread-1" })) as {
      checklist: Checklist;
    };
    expect(after.checklist.status).toBe("active");
    expect(after.checklist.steps.at(-1)?.checked).toBe(false);
  });

  it("rejects derived checklist statuses from the public settings RPC", async () => {
    const host = await startHost();
    const attached = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;

    await expect(
      host.harness.callRpc("updateSettings", {
        checklistId: attached.id,
        status: "completed",
      }),
    ).rejects.toThrow();
  });
});

function agentContext(threadId: string): Parameters<TestHost["harness"]["resolveAgentConfiguration"]>[0] {
  return {
    thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: "project-1", kind: "standard", name: "Project", gitRemoteUrl: null },
    environment: {
      id: "env-1",
      name: null,
      path: null,
      workspaceProvisionType: "personal",
      branchName: null,
    },
    host: { id: "host-1", name: "Host" },
    provider: { id: "codex", model: "test", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: null },
  };
}

async function resolveFor(host: TestHost, threadId: string) {
  const resolved = await host.harness.resolveAgentConfiguration(agentContext(threadId));
  const toolInstructions = resolved.tools.map((tool) => tool.instructions ?? "").join("\n");
  return {
    toolNames: resolved.tools.map((tool) => tool.name).sort(),
    instructions: resolved.instructions,
    surface: `${resolved.instructions ?? ""}\n${toolInstructions}`,
  };
}

describe("Checklists agent activation", () => {
  it("gives a thread without a Checklist no checklist tools or instructions", async () => {
    const host = await startHost();
    const resolved = await resolveFor(host, "thread-1");
    expect(resolved.toolNames).toEqual([]);
    expect(resolved.instructions).toBeNull();
    expect(resolved.surface).not.toMatch(/checklist/i);
  });

  it("gives an attached thread its tools and instructions", async () => {
    const host = await startHost();
    await host.harness.callRpc("attach", { threadId: "thread-1", templateId: softwareTemplateId(host) });
    const resolved = await resolveFor(host, "thread-1");
    expect(resolved.toolNames).toEqual(["agent_checklist_get", "agent_checklist_update"]);
    expect(resolved.instructions).toContain("Checklist is attached");
    expect(resolved.surface).toContain("Read the checklist before starting work");
  });

  it("follows attach, detach, and replacement on the next resolution", async () => {
    const host = await startHost();
    expect((await resolveFor(host, "thread-1")).toolNames).toEqual([]);

    const first = (await host.harness.callRpc("attach", {
      threadId: "thread-1",
      templateId: softwareTemplateId(host),
    })) as Checklist;
    expect((await resolveFor(host, "thread-1")).toolNames).toHaveLength(2);

    await host.harness.callRpc("detach", { checklistId: first.id });
    const detached = await resolveFor(host, "thread-1");
    expect(detached.toolNames).toEqual([]);
    expect(detached.surface).not.toMatch(/checklist/i);

    await host.harness.callRpc("attach", { threadId: "thread-1", templateId: researchTemplateId(host) });
    expect((await resolveFor(host, "thread-1")).toolNames).toHaveLength(2);
    const read = await host.harness.callAgentTool("agent_checklist_get", {}, {
      threadId: "thread-1",
      projectId: "project-1",
    });
    expect(String(read)).toContain("Research to technical document");
    expect(String(read)).not.toContain("Software delivery");
  });

  it("resolves each thread independently and survives a reload", async () => {
    const host = await startHost();
    await host.harness.callRpc("attach", { threadId: "thread-1", templateId: softwareTemplateId(host) });
    expect((await resolveFor(host, "thread-1")).toolNames).toHaveLength(2);
    expect((await resolveFor(host, "thread-2")).toolNames).toEqual([]);

    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    expect((await resolveFor(reloaded, "thread-1")).toolNames).toHaveLength(2);
    expect((await resolveFor(reloaded, "thread-2")).toolNames).toEqual([]);
  });

  it("answers a stale tool call in an unattached thread without a Checklist", async () => {
    const host = await startHost();
    const read = await host.harness.callAgentTool("agent_checklist_get", {}, {
      threadId: "thread-1",
      projectId: "project-1",
    });
    expect(JSON.parse(String(read))).toEqual({
      checklist: null,
      message: "No Checklist is attached to this thread.",
    });
  });
});
