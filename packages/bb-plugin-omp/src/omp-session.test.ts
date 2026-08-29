import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OmpRpcSession } from "./omp-session.js";

const fakeRpc = new URL("./fake-omp-rpc.mjs", import.meta.url).pathname;

describe("OMP RPC session", () => {
  it("starts with model/thinking flags and streams a prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-omp-session-test-"));
    const sessionFile = join(root, "session.jsonl");
    const argsLog = join(root, "args.log");
    const events: Record<string, unknown>[] = [];
    let settleEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      settleEnded = resolve;
    });
    const session = new OmpRpcSession({
      command: process.execPath,
      baseArgs: [fakeRpc],
      cwd: root,
      env: {
        ...process.env,
        FAKE_OMP_SESSION_FILE: sessionFile,
        FAKE_OMP_ARGS_LOG: argsLog,
      },
      sessionDir: join(root, "sessions"),
      tempDir: join(root, "tmp"),
      recordThreadId: "thr_test",
      model: "fake/fake-model",
      thinkingLevel: "high",
      instructions: "test instructions",
      instructionMode: "append",
      autoApprove: true,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "agent_end") settleEnded();
      },
      onUnmatchedResponse: () => undefined,
      onExit: () => undefined,
    });
    try {
      const state = await session.start();
      expect(state.sessionFile).toBe(sessionFile);
      await session.prompt("hello");
      await ended;
      expect(events.some((event) => event.type === "message_update")).toBe(true);
      const args = JSON.parse(readFileSync(argsLog, "utf8").trim()) as string[];
      expect(args).toEqual(expect.arrayContaining([
        "--mode", "rpc", "--model", "fake/fake-model", "--thinking", "high",
        "--auto-approve", "--approval-mode", "yolo",
      ]));
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finishes a local-only command and leaves the session inactive", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-omp-local-test-"));
    const events: Record<string, unknown>[] = [];
    const session = new OmpRpcSession({
      command: process.execPath,
      baseArgs: [fakeRpc],
      cwd: root,
      env: {
        ...process.env,
        FAKE_OMP_SESSION_FILE: join(root, "session.jsonl"),
        FAKE_OMP_LOCAL_PROMPT: "1",
      },
      sessionDir: join(root, "sessions"),
      tempDir: join(root, "tmp"),
      recordThreadId: "thr_local",
      instructionMode: "append",
      autoApprove: true,
      onEvent: (event) => events.push(event),
      onUnmatchedResponse: () => undefined,
      onExit: () => undefined,
    });
    try {
      await session.start();
      await session.prompt("/help");
      expect(session.isActive).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "command_output", text: "local:/help" }),
        expect.objectContaining({ type: "prompt_result", agentInvoked: false }),
      ]));
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for a terminal compaction event before resolving", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-omp-compact-test-"));
    const events: Record<string, unknown>[] = [];
    const session = new OmpRpcSession({
      command: process.execPath,
      baseArgs: [fakeRpc],
      cwd: root,
      env: {
        ...process.env,
        FAKE_OMP_SESSION_FILE: join(root, "session.jsonl"),
      },
      sessionDir: join(root, "sessions"),
      tempDir: join(root, "tmp"),
      recordThreadId: "thr_compact",
      instructionMode: "append",
      autoApprove: true,
      onEvent: (event) => events.push(event),
      onUnmatchedResponse: () => undefined,
      onExit: () => undefined,
    });
    try {
      await session.start();
      await session.compact();
      expect(session.isActive).toBe(false);
      expect(events.map((event) => event.type)).toEqual([
        "compaction_start",
        "compaction_end",
      ]);
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["success", false],
    ["skip", false],
    ["fail", true],
    ["abort", true],
  ] as const)("reports terminal compaction mode %s", async (mode, rejected) => {
    const root = mkdtempSync(join(tmpdir(), "bb-omp-compact-mode-test-"));
    const session = new OmpRpcSession({
      command: process.execPath,
      baseArgs: [fakeRpc],
      cwd: root,
      env: {
        ...process.env,
        FAKE_OMP_SESSION_FILE: join(root, "session.jsonl"),
        FAKE_OMP_COMPACTION_MODE: mode,
      },
      sessionDir: join(root, "sessions"),
      tempDir: join(root, "tmp"),
      recordThreadId: `thr_compact_${mode}`,
      instructionMode: "append",
      autoApprove: true,
      onEvent: () => undefined,
      onUnmatchedResponse: () => undefined,
      onExit: () => undefined,
    });
    try {
      await session.start();
      if (rejected) {
        await expect(session.compact()).rejects.toThrow(/provider error|interrupted/);
      } else {
        await expect(session.compact()).resolves.toBeUndefined();
      }
      expect(session.isActive).toBe(false);
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers final events before an OMP child exit is reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-omp-exit-test-"));
    const events: Record<string, unknown>[] = [];
    let resolveEnd: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
    let resolveExit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const session = new OmpRpcSession({
      command: process.execPath,
      baseArgs: [fakeRpc],
      cwd: root,
      env: {
        ...process.env,
        FAKE_OMP_SESSION_FILE: join(root, "session.jsonl"),
        FAKE_OMP_EXIT_AFTER_PROMPT: "1",
      },
      sessionDir: join(root, "sessions"),
      tempDir: join(root, "tmp"),
      recordThreadId: "thr_exit",
      instructions: "secret test instructions",
      instructionMode: "append",
      autoApprove: true,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "agent_end") resolveEnd();
      },
      onUnmatchedResponse: () => undefined,
      onExit: () => resolveExit(),
    });
    try {
      await session.start();
      await session.prompt("final");
      await ended;
      await exited;
      expect(events.at(-1)).toMatchObject({ type: "agent_end" });
      expect(session.isActive).toBe(false);
      expect(readdirSync(join(root, "tmp"))).toEqual([]);
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels a child that is still waiting to become ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-omp-start-test-"));
    const session = new OmpRpcSession({
      command: process.execPath,
      baseArgs: [fakeRpc],
      cwd: root,
      env: {
        ...process.env,
        FAKE_OMP_SESSION_FILE: join(root, "session.jsonl"),
        FAKE_OMP_READY_DELAY_MS: "1000",
      },
      sessionDir: join(root, "sessions"),
      tempDir: join(root, "tmp"),
      recordThreadId: "thr_start",
      instructionMode: "append",
      autoApprove: true,
      onEvent: () => undefined,
      onUnmatchedResponse: () => undefined,
      onExit: () => undefined,
    });
    try {
      const starting = session.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await session.close();
      await expect(starting).rejects.toThrow(/OMP session closed during startup|omp exited/);
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
