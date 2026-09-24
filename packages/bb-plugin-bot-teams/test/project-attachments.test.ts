import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { attachmentsForProject } from "../project-attachments";
import type { Attachment } from "../contract";

const attachment: Attachment = {
  id: randomUUID(),
  roomId: randomUUID(),
  projectId: "old_project",
  name: "brief.txt",
  path: "stored/brief.txt",
  mimeType: "text/plain",
  type: "localFile",
  sizeBytes: 5,
};
test("copies cross-project inputs once and reuses the uploaded reference", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bot-teams",
    sdk: {
      projects: {
        attachments: {
          read: async () => ({
            bytes: new Uint8Array([1, 2]),
            mimeType: "text/plain",
            sizeBytes: 2,
          }),
          upload: async () => ({
            path: "stored/copy.txt",
            name: "brief.txt",
            type: "localFile",
            sizeBytes: 2,
            mimeType: "text/plain",
          }),
        },
      },
    },
  });
  try {
    const input = [attachment];
    const required = new Set([attachment.id]);
    const first = await attachmentsForProject(
      bb,
      input,
      "proj_personal",
      required,
    );
    assert.deepEqual(first, {
      attachments: [
        { ...attachment, projectId: "proj_personal", path: "stored/copy.txt" },
      ],
      unavailable: [],
    });
    assert.deepEqual(
      await attachmentsForProject(bb, input, "proj_personal", required),
      first,
    );
    assert.equal(
      harness.inspection.sdk.callsTo("projects.attachments.upload").length,
      1,
    );
    assert.equal(attachment.projectId, "old_project");
    assert.deepEqual(
      await attachmentsForProject(bb, input, "old_project", required),
      { attachments: input, unavailable: [] },
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
test("missing historical files are disclosed, required files fail, and outages are not treated as deletion", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bot-teams",
    sdk: {
      projects: {
        attachments: {
          read: async () => {
            throw new Error("HTTP 404: Project not found");
          },
        },
      },
    },
  });
  try {
    assert.deepEqual(
      await attachmentsForProject(bb, [attachment], "proj_personal", new Set()),
      { attachments: [], unavailable: [attachment.name] },
    );
    await assert.rejects(
      attachmentsForProject(
        bb,
        [attachment],
        "proj_personal",
        new Set([attachment.id]),
      ),
      /Upload it again/,
    );
    harness.inspection.sdk.stub("projects.attachments.read", async () => {
      throw new Error("HTTP 503: unavailable");
    });
    await assert.rejects(
      attachmentsForProject(bb, [attachment], "proj_personal", new Set()),
      /503/,
    );
    assert.equal(
      harness.inspection.sdk.callsTo("projects.attachments.upload").length,
      0,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
