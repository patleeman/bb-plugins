import test from "node:test";
import assert from "node:assert/strict";
import { activitySnippetFromTimeline } from "../activity";
import { channelWorkActivity } from "../channel-work";

test("activity snippets use the latest useful transcript row", () => {
  assert.equal(
    activitySnippetFromTimeline({
      rows: [
        {
          id: "assistant-1",
          kind: "conversation",
          role: "assistant",
          sourceSeqEnd: 4,
          text: "I’m checking the project before making a change.",
        },
        {
          id: "command-1",
          kind: "work",
          sourceSeqEnd: 5,
          workKind: "command",
          command: "git status --short\n--branch",
        },
      ],
    }),
    "Running git status --short --branch",
  );
});

test("activity snippets prefer specific work titles over generic labels", () => {
  assert.equal(
    activitySnippetFromTimeline({
      rows: [
        {
          id: "command-1",
          kind: "work",
          sourceSeqEnd: 5,
          workKind: "command",
          command: '/bin/zsh -lc "git status --short --branch"',
          presentation: {
            label: { pending: "Running command", completed: "Ran command" },
            title: "git status --short --branch",
          },
        },
      ],
    }),
    "Running git status --short --branch",
  );
});

test("activity snippets ignore private thinking and stay on one line", () => {
  const snippet = activitySnippetFromTimeline({
    activeThinking: { text: "private reasoning that must not be shown" },
    rows: [
      {
        id: "work-1",
        kind: "work",
        sourceSeqEnd: 2,
        workKind: "search",
        query: "runtime.ts\nserver.ts",
      },
    ],
  });
  assert.equal(snippet, "Searching runtime.ts server.ts");
  assert.ok(!snippet?.includes("private reasoning"));
  assert.equal(snippet?.includes("\n"), false);
});

test("nested work rows are reduced to their latest visible detail", () => {
  assert.equal(
    activitySnippetFromTimeline({
      rows: [
        {
          id: "turn-1",
          kind: "turn",
          sourceSeqEnd: 1,
          children: [
            {
              id: "file-1",
              kind: "work",
              sourceSeqEnd: 2,
              workKind: "file-read",
              path: "/workspace/MISSION.md",
            },
          ],
        },
      ],
    }),
    "Reading /workspace/MISSION.md",
  );
});

test("silence markers never become visible channel activity", () => {
  for (const text of ["[PASS]", " **[PASS]** "])
    assert.equal(
      activitySnippetFromTimeline({
        rows: [{ kind: "conversation", role: "assistant", text }],
      }),
      null,
    );
  assert.equal(
    channelWorkActivity({ status: "running", activitySnippet: "[PASS]" }),
    "Working…",
  );
  assert.equal(
    channelWorkActivity({
      status: "running",
      activitySnippet: "All checks PASS",
    }),
    "All checks PASS",
  );
});

test("stopping and queued states replace stale activity in the compact row", () => {
  assert.equal(
    channelWorkActivity({
      status: "running",
      cancellationPending: true,
      activitySnippet: "Reading files",
    }),
    "Stopping…",
  );
  assert.equal(
    channelWorkActivity({
      status: "queued",
      queueReason: "Waiting for Atlas",
      queuePosition: 2,
      activitySnippet: "Old work",
    }),
    "Waiting for Atlas · Position 2",
  );
  assert.equal(
    channelWorkActivity({ status: "dispatching", activitySnippet: "Old work" }),
    "Preparing response…",
  );
});
