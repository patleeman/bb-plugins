#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sessionFile = process.env.FAKE_OMP_SESSION_FILE;
if (process.env.FAKE_OMP_ARGS_LOG) {
  appendFileSync(process.env.FAKE_OMP_ARGS_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
}
if (sessionFile) {
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, "fake session\n", { flag: "a" });
}

const model = {
  provider: "fake",
  id: "fake-model",
  contextWindow: 128_000,
};
let streaming = false;
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, command, data) {
  send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

function runPrompt(message) {
  if (process.env.FAKE_OMP_LOCAL_PROMPT === "1") {
    send({ type: "command_output", text: `local:${message}` });
    send({ type: "prompt_result", agentInvoked: false });
    return;
  }
  streaming = true;
  send({ type: "agent_start" });
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thinking" } });
  send({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "thinking" } });
  const text = `reply:${message}`;
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  send({
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { input: 2, output: 3, totalTokens: 5 },
    }],
  });
  streaming = false;
  if (process.env.FAKE_OMP_EXIT_AFTER_PROMPT === "1") {
    process.stdout.end(() => process.exit(0));
  }
}

const readyDelay = Number(process.env.FAKE_OMP_READY_DELAY_MS ?? "0");
if (readyDelay > 0) setTimeout(() => send({ type: "ready" }), readyDelay);
else send({ type: "ready" });

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    if (process.env.FAKE_OMP_COMMAND_LOG) {
      appendFileSync(process.env.FAKE_OMP_COMMAND_LOG, `${command.type}\n`);
    }
    if (command.type === "get_state") {
      response(command.id, "get_state", {
        model,
        isStreaming: streaming,
        isCompacting: false,
        sessionFile,
        sessionId: "fake-session",
        contextUsage: { tokens: 5, contextWindow: 128_000 },
      });
    } else if (command.type === "get_session_stats") {
      response(command.id, "get_session_stats", {
        contextUsage: { tokens: 5, contextWindow: 128_000 },
      });
    } else if (command.type === "prompt") {
      if (process.env.FAKE_OMP_LOCAL_PROMPT === "1") {
        send({ type: "command_output", text: `local:${command.message}` });
        send({ type: "prompt_result", id: command.id, agentInvoked: false });
        response(command.id, "prompt", { agentInvoked: false });
      } else {
        response(command.id, "prompt");
        if (command.streamingBehavior !== "steer") {
          setImmediate(() => runPrompt(command.message));
        }
      }
    } else if (command.type === "compact") {
      response(command.id, "compact");
      setImmediate(() => {
        const mode = process.env.FAKE_OMP_COMPACTION_MODE ?? "success";
        send({ type: "compaction_start", reason: "manual" });
        send({
          type: "compaction_end",
          reason: "manual",
          ...(mode === "skip"
            ? { errorMessage: "Compaction failed: Nothing to compact (session too small)" }
            : mode === "fail"
              ? { errorMessage: "Compaction failed: provider error" }
              : mode === "abort" ? { aborted: true } : {}),
        });
      });
    } else if (command.type === "abort") {
      response(command.id, "abort");
    }
  }
});

process.stdin.on("end", () => process.exit(0));
