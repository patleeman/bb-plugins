// "Save as page": the Markdown a Studio page is made from. Markdown is copied
// as is; text and code go in a fence longer than any backtick run inside.
import { formatBytes, isTextType } from "../shared";
import { versionType, type VersionRow } from "./store";
import { TEXT_SCAN_BYTES } from "./studio";

/** `text` is the version's text from `artifactText`: null when it isn't text or is too big to read. */
export function pageMarkdown(version: Pick<VersionRow, "name" | "mime" | "size">, text: string | null): string {
  const type = versionType(version);
  if (type === "html" || !isTextType(type)) throw new Error("Only Markdown, text and code artifacts can become pages.");
  if (text === null) {
    throw new Error(
      version.size > TEXT_SCAN_BYTES
        ? `${version.name} is ${formatBytes(version.size)}; pages can be made from text up to ${formatBytes(TEXT_SCAN_BYTES)}.`
        : "This artifact's contents are missing.",
    );
  }
  if (type === "markdown") return text;
  // A loop, not Math.max(...runs): a long file can have more runs than a call takes arguments.
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${type === "code" ? (version.name.split(".").pop() ?? "") : ""}\n${text}\n${fence}`;
}
