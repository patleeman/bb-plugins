import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Attachment } from "./contract";

/** BB validates attachment references against the receiving thread's project. */
export async function attachmentsForProject(
  bb: BbPluginApi,
  attachments: Attachment[],
  projectId: string,
  requiredIds: ReadonlySet<string>,
) {
  const resolved: Attachment[] = [];
  const unavailable: string[] = [];
  for (const attachment of attachments) {
    if (attachment.projectId === projectId) {
      resolved.push(attachment);
      continue;
    }
    const key = `attachment-copy:${attachment.id}:${projectId}`;
    const cached = await bb.storage.kv.get<Attachment>(key);
    if (cached) {
      resolved.push(cached);
      continue;
    }
    let source;
    try {
      source = await bb.sdk.projects.attachments.read({
        projectId: attachment.projectId,
        path: attachment.path,
      });
    } catch (cause) {
      if (
        !/HTTP 404|(?:attachment|project|file) not found/i.test(String(cause))
      )
        throw cause;
      if (requiredIds.has(attachment.id))
        throw new Error(
          `Attachment ${attachment.name} is no longer available. Upload it again before retrying.`,
        );
      unavailable.push(attachment.name);
      continue;
    }
    const uploaded = await bb.sdk.projects.attachments.upload({
      projectId,
      clientFile: source.bytes,
      filename: attachment.name,
      mimeType: attachment.mimeType,
    });
    const copy = { ...attachment, projectId, path: uploaded.path };
    await bb.storage.kv.set(key, copy);
    resolved.push(copy);
  }
  return { attachments: resolved, unavailable };
}
