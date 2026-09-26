/** Open the private work record for a channel bot. */
export function openWorkThread(
  navigate: { toThread(threadId: string): void },
  threadId: string,
  _roomId: string | null | undefined,
) {
  navigate.toThread(threadId);
}
