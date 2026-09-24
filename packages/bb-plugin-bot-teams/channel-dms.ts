/**
 * A bot's DM is a row in this plugin's store pointing at a BB thread. Deleting
 * the thread — or the project holding it — leaves the row behind, and a row
 * that opens onto nothing is worse than no row at all.
 */
export async function liveChannelDms<Row extends { threadId: string }>(
  conversations: readonly Row[],
  threadExists: (threadId: string) => Promise<boolean>,
): Promise<{ live: Row[]; stale: string[] }> {
  const checked = await Promise.all(
    conversations.map(async (row) => [row, await threadExists(row.threadId)] as const),
  );
  return {
    live: checked.flatMap(([row, exists]) => (exists ? [row] : [])),
    stale: checked.flatMap(([row, exists]) => (exists ? [] : [row.threadId])),
  };
}
