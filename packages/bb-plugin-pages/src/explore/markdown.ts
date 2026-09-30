// Turns the worker's final message into the page we save: the Markdown
// document, with its trailing `::explore` line lifted out into follow-ups.
import { MAX_FOLLOW_UPS, parseExploreItems, type ExploreItem } from "./shared";

/** Pages accepts 200k characters; leave room for the footer. */
export const MAX_MARKDOWN = 180_000;
/** Shorter than this, the worker didn't write an explainer. */
export const MIN_MARKDOWN = 80;

const TRAILING_DIRECTIVE = /^::([a-z][a-z0-9-]*)\{([^\n]*)\}\s*$/;
const ITEMS = /items="([^"]*)"/;
const PREAMBLE = /^(?:here(?:'s| is| are)|sure\b|okay\b|ok\b|below\b|i(?:'ve| have) (?:written|put together|investigated))/i;

/** A fence around the whole document (```markdown … ```), not a diagram or code block. */
function unwrapFence(text: string): string {
  const match = /^(`{3,}|~{3,})[ \t]*(markdown|md)?[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i.exec(text);
  if (!match) return text;
  const [, , lang, body = ""] = match;
  // A bare fence around a whole document holds Markdown; around one block of code it's code.
  if (!lang && !/^#{1,6} /m.test(body)) return text;
  return body.trim();
}

/** The fence (like ``` or ~~~~) still open at the end of `text`, if any. */
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!open) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && !line.trim().slice(marker.length).trim()) open = null;
  }
  return open;
}

/** Lines that are a `::reactions{…}` directive, outside fenced code. */
function dropStrayReactions(lines: string[]): string[] {
  let open: string | null = null;
  return lines.filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!open) open = marker;
      else if (marker[0] === open[0] && marker.length >= open.length && !line.trim().slice(marker.length).trim()) open = null;
      return true;
    }
    return open !== null || !/^::reactions\{[^\n]*\}\s*$/.test(line.trim());
  });
}

export interface CleanedExplainer {
  markdown: string;
  followUps: ExploreItem[];
}

/**
 * Cleans the worker's output. Throws when there's no usable document, so the
 * job fails with a message rather than saving an empty page.
 */
export function cleanExplainerMarkdown(output: string | null | undefined): CleanedExplainer {
  let text = (output ?? "").replace(/\r\n?/g, "\n").trim();
  text = unwrapFence(text);

  let lines = text.split("\n");
  // Chatter before the document ("Here's the explainer:") when a heading follows.
  const firstHeading = lines.findIndex((line) => /^#{1,6} /.test(line));
  if (firstHeading > 0 && firstHeading <= 3 && PREAMBLE.test(lines[0]!.trim())) lines = lines.slice(firstHeading);
  // The page has its own title: drop a leading H1.
  if (lines[0] && /^# /.test(lines[0])) lines = lines.slice(1);

  // Trailing directive lines: `::explore` becomes follow-ups; others (like
  // `::reactions`) mean nothing in a page.
  let followUps: ExploreItem[] = [];
  while (lines.length) {
    const last = lines[lines.length - 1]!.trim();
    if (!last) {
      lines.pop();
      continue;
    }
    const directive = TRAILING_DIRECTIVE.exec(last);
    if (!directive) break;
    if (directive[1] === "explore" && !followUps.length) followUps = parseExploreItems(ITEMS.exec(directive[2] ?? "")?.[1], MAX_FOLLOW_UPS);
    lines.pop();
  }

  // A `::reactions` line elsewhere (outside code) is Emoji React's, meant for a chat reply.
  lines = dropStrayReactions(lines);

  let markdown = lines.join("\n").trim();
  if (markdown.length < MIN_MARKDOWN) throw new Error("The explainer came back empty. Try again.");
  if (markdown.length > MAX_MARKDOWN) {
    const room = markdown.slice(0, MAX_MARKDOWN);
    const breakAt = room.lastIndexOf("\n\n");
    let body = (breakAt > MAX_MARKDOWN / 2 ? room.slice(0, breakAt) : room).trimEnd();
    // A cut inside a fence would swallow the rest of the page: close it.
    const open = openFence(body);
    if (open) body = `${body}\n${open}`;
    markdown = `${body}\n\n*This explainer was cut short because it was too long.*`;
  }
  return { markdown, followUps };
}
