import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";

/** New bot sessions belong to BB's protected Personal project. Existing threads
 * keep their identity and history; changing a bot profile does not move them. */
export async function usePersonalProject(
  bb: BbPluginApi,
  store: Store,
  migrateSchedules?: (from: string, to: string) => Promise<void>,
) {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const personal = projects.find((project) => project.kind === "personal");
  if (!personal)
    throw new Error(
      "BB's Personal project is unavailable. Retry after BB has started.",
    );
  const previous = new Set([
    ...((await bb.storage.kv.get<string[]>("previousProjectIds")) ?? []),
    ...store.all().map((bot) => bot.projectId),
  ]);
  const saved = await bb.storage.kv.get<string>("projectId");
  if (saved) previous.add(saved);
  await bb.storage.kv.set(
    "previousProjectIds",
    [...previous].filter((id) => id !== personal.id),
  );
  for (const projectId of previous)
    if (projectId && projectId !== personal.id)
      await migrateSchedules?.(projectId, personal.id);
  store.db.transaction(() => {
    for (const bot of store.all()) {
      if (bot.projectId === personal.id) continue;
      // Project deletion removes every owned thread. There is nothing left to
      // locate or stop for an interrupted dispatch; never replay that request.
      if (!projects.some((project) => project.id === bot.projectId)) {
        for (const job of store.work(bot.id)) {
          if (!job.cancellationPending && job.status !== "dispatching")
            continue;
          store.putJob({
            ...job,
            cancellationPending: false,
            status: job.status === "cancelled" ? "cancelled" : "error",
            error:
              job.error ??
              "The Bots project was deleted. Retry this response to start again.",
          });
        }
      }
      store.put({ ...bot, projectId: personal.id });
    }
  })();
  await bb.storage.kv.set("projectId", personal.id);
  return personal.id;
}
