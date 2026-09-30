// Which bot mentions and comments the page watcher has already handled. A
// mention or comment stays unseen until the watcher has sent it to Studio Teams,
// so requests made while Studio Teams is unavailable go out once it's back.

import { HUMAN_USER_ID } from "./constants";

export interface Seen {
  mentions: Set<string>;
  comments: Set<string>;
  /** The mentions on the page as of the last change the watcher saw, handled or not. */
  present: Set<string>;
}

export interface Found<M extends { blockId: string; target: string }, C extends { id: string; author: string }> {
  mentions: M[];
  comments: C[];
}

const mentionKey = (mention: { blockId: string; target: string }) => `${mention.blockId}:${mention.target}`;

export function emptySeen(): Seen {
  return { mentions: new Set(), comments: new Set(), present: new Set() };
}

/** The mentions and comments in `found` that haven't been handled. */
export function unseen<M extends { blockId: string; target: string }, C extends { id: string; author: string }>(
  seen: Seen,
  found: Found<M, C>,
): Found<M, C> {
  return {
    mentions: found.mentions.filter((mention) => !seen.mentions.has(mentionKey(mention))),
    comments: found.comments.filter((comment) => !seen.comments.has(comment.id)),
  };
}

export function markSeen(seen: Seen, found: Found<{ blockId: string; target: string }, { id: string; author: string }>): void {
  for (const mention of found.mentions) seen.mentions.add(mentionKey(mention));
  for (const comment of found.comments) seen.comments.add(comment.id);
}

/** Records the mentions on the page after the user's change. */
export function notePresent(seen: Seen, found: Found<{ blockId: string; target: string }, { id: string; author: string }>): void {
  seen.present = new Set(found.mentions.map(mentionKey));
}

/**
 * Marks what an agent or bot just wrote as handled, so their own mentions and
 * comments don't trigger bots. The user's comments and mentions stay pending:
 * they may be waiting on the debounce or on Studio Teams.
 */
export function absorbAgentChange(seen: Seen, found: Found<{ blockId: string; target: string }, { id: string; author: string }>): void {
  markSeen(seen, {
    mentions: found.mentions.filter((mention) => !seen.present.has(mentionKey(mention))),
    comments: found.comments.filter((comment) => comment.author !== HUMAN_USER_ID),
  });
  notePresent(seen, found);
}
