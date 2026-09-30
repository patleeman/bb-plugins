import { blocksToYXmlFragment, yXmlFragmentToBlocks, _blocksToProsemirrorNode } from "@blocknote/core/yjs";
import type { Mark, Node as PMNode, Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { blocksToMarkdown, markdownToBlocks, shortId, type PageBlock } from "./markdown";
import { DOCUMENT_FRAGMENT } from "./schema-config";
import { createServerEditor, type PageEditor } from "./schema-server";

// Server-side access to a page's Y.Doc. Agent edits are applied as
// ProseMirror transforms against a snapshot of the document and written back
// with y-prosemirror's diffing `updateYFragment`, so only the touched blocks
// change in Yjs: concurrent edits from open editors merge normally and
// comment marks on untouched text survive.

let sharedEditor: PageEditor | null = null;
export function serverEditor(): PageEditor {
  sharedEditor ??= createServerEditor();
  return sharedEditor;
}
const pmSchema = (): Schema => serverEditor().pmSchema as unknown as Schema;

export const fragmentOf = (doc: Y.Doc) => doc.getXmlFragment(DOCUMENT_FRAGMENT);

export function readBlocks(doc: Y.Doc): PageBlock[] {
  return yXmlFragmentToBlocks(serverEditor(), fragmentOf(doc)) as unknown as PageBlock[];
}

export function readMarkdown(doc: Y.Doc, options: { ids?: boolean } = {}): string {
  const blocks = readBlocks(doc);
  return blocks.length ? blocksToMarkdown(trimTrailingEmpty(blocks), options) : "";
}

/**
 * Seeds an empty doc. Only valid before any editor has connected. An empty
 * page still gets one paragraph, so editors never have to create the
 * document structure (two editors doing that at once would duplicate it).
 */
export function seedMarkdown(doc: Y.Doc, markdown: string): void {
  const blocks = markdownToBlocks(markdown);
  doc.transact(() => {
    blocksToYXmlFragment(serverEditor(), (blocks.length ? blocks : [{ type: "paragraph" }]) as never, fragmentOf(doc));
  }, "seed");
}

function trimTrailingEmpty(blocks: PageBlock[]): PageBlock[] {
  let end = blocks.length;
  while (end > 1 && isEmptyParagraph(blocks[end - 1]!)) end--;
  return blocks.slice(0, end);
}

function isEmptyParagraph(block: PageBlock): boolean {
  return (
    block.type === "paragraph" &&
    Array.isArray(block.content) &&
    block.content.length === 0 &&
    !block.children?.length
  );
}

// ---------------------------------------------------------------------------
// Block lookup

export interface FoundBlock {
  id: string;
  pos: number;
  node: PMNode;
}

export class PageEditError extends Error {}

function blockContainers(doc: PMNode): FoundBlock[] {
  const found: FoundBlock[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer") found.push({ id: String(node.attrs.id), pos, node });
    return true;
  });
  return found;
}

/** Finds a block by full id or a unique prefix of its dash-less id. */
export function findBlock(doc: PMNode, ref: string): FoundBlock {
  const wanted = ref.trim().replace(/^\^/, "");
  const all = blockContainers(doc);
  const exact = all.find((block) => block.id === wanted);
  if (exact) return exact;
  const prefix = wanted.replace(/-/g, "").toLowerCase();
  if (prefix.length < 4) throw new PageEditError(`Block id "${ref}" is too short; use at least 4 characters.`);
  const hits = all.filter((block) => block.id.replace(/-/g, "").toLowerCase().startsWith(prefix));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new PageEditError(`Block id "${ref}" is ambiguous; use more characters.`);
  throw new PageEditError(`No block with id "${ref}". Read the page again for current ids.`);
}

// ---------------------------------------------------------------------------
// Edits

export type EditOp =
  | { op: "insert_after" | "insert_before" | "replace"; block: string; markdown: string }
  | { op: "append" | "prepend"; markdown: string }
  | { op: "delete"; block: string }
  | { op: "set_checked"; block: string; checked: boolean }
  | { op: "replace_text"; block?: string; find: string; replace: string }
  | { op: "replace_all"; markdown: string };

export interface EditResult {
  /** Ids of blocks created or changed, in document order of the ops. */
  touched: string[];
  /** Whether the transaction changed anything. */
  changed: boolean;
}

function containersFor(markdown: string): PMNode[] {
  const blocks = markdownToBlocks(markdown);
  if (!blocks.length) throw new PageEditError("The markdown produced no blocks.");
  const root = _blocksToProsemirrorNode(serverEditor(), blocks as never) as unknown as PMNode;
  const containers: PMNode[] = [];
  root.firstChild!.forEach((node) => containers.push(node));
  return containers;
}

function emptyContainers(): PMNode[] {
  const root = _blocksToProsemirrorNode(serverEditor(), [{ type: "paragraph" }] as never) as unknown as PMNode;
  return [root.firstChild!.firstChild!];
}

function topGroup(doc: PMNode): { start: number; end: number; group: PMNode } {
  const group = doc.firstChild!;
  return { start: 1, end: 1 + group.content.size, group };
}

function applyOp(tr: Transform, op: EditOp, touched: string[]): void {
  const doc = tr.doc;
  switch (op.op) {
    case "insert_after":
    case "insert_before": {
      const target = findBlock(doc, op.block);
      const nodes = containersFor(op.markdown);
      tr.insert(op.op === "insert_after" ? target.pos + target.node.nodeSize : target.pos, nodes);
      touched.push(...nodes.map((node) => String(node.attrs.id)));
      return;
    }
    case "replace": {
      const target = findBlock(doc, op.block);
      const nodes = containersFor(op.markdown);
      // Keep the replaced block's id so references to it stay valid.
      nodes[0] = nodes[0]!.type.create({ ...nodes[0]!.attrs, id: target.id }, nodes[0]!.content, nodes[0]!.marks);
      tr.replaceWith(target.pos, target.pos + target.node.nodeSize, nodes);
      touched.push(...nodes.map((node) => String(node.attrs.id)));
      return;
    }
    case "append":
    case "prepend": {
      const nodes = containersFor(op.markdown);
      const { start, end, group } = topGroup(doc);
      let pos = op.op === "prepend" ? start : end;
      if (op.op === "append") {
        // Insert before the editor's trailing empty paragraph, if present.
        const last = group.lastChild;
        if (last && group.childCount > 1 && last.textContent === "" && last.childCount === 1 && last.firstChild!.type.name === "paragraph") {
          pos = end - last.nodeSize;
        }
      }
      tr.insert(pos, nodes);
      touched.push(...nodes.map((node) => String(node.attrs.id)));
      return;
    }
    case "delete": {
      const target = findBlock(doc, op.block);
      const { group } = topGroup(doc);
      if (group.childCount === 1 && group.firstChild === target.node) {
        tr.replaceWith(target.pos, target.pos + target.node.nodeSize, containersFor("​"));
        tr.delete(target.pos + 2, target.pos + 2 + 1);
      } else {
        tr.delete(target.pos, target.pos + target.node.nodeSize);
      }
      return;
    }
    case "set_checked": {
      const target = findBlock(doc, op.block);
      const content = target.node.firstChild!;
      if (content.type.name !== "checkListItem") {
        throw new PageEditError(`Block ${shortId(target.id)} is a ${content.type.name}, not a checklist item.`);
      }
      tr.setNodeMarkup(target.pos + 1, undefined, { ...content.attrs, checked: op.checked });
      touched.push(target.id);
      return;
    }
    case "replace_text": {
      if (!op.find) throw new PageEditError("replace_text needs a non-empty `find`.");
      const scope = op.block ? [findBlock(doc, op.block)] : blockContainers(doc);
      for (const block of scope) {
        const content = block.node.firstChild!;
        if (!content.isTextblock) continue;
        const range = findText(content, block.pos + 2, op.find);
        if (!range) continue;
        if (op.replace) {
          const marks: readonly Mark[] = doc.resolve(range.from + 1).marks();
          tr.replaceWith(range.from, range.to, doc.type.schema.text(op.replace, marks));
        } else {
          tr.delete(range.from, range.to);
        }
        touched.push(block.id);
        return;
      }
      throw new PageEditError(`Text "${truncate(op.find, 60)}" not found${op.block ? ` in block ${op.block}` : ""}.`);
    }
    case "replace_all": {
      const nodes = containersFor(op.markdown);
      const { start, end } = topGroup(doc);
      tr.replaceWith(start, end, nodes);
      touched.push(...nodes.map((node) => String(node.attrs.id)));
      return;
    }
  }
}

/** Maps a string match inside a textblock (inline atoms count as U+FFFC). */
function findText(textblock: PMNode, contentStart: number, needle: string): { from: number; to: number } | null {
  let text = "";
  const positions: number[] = [];
  textblock.forEach((child, offset) => {
    if (child.isText) {
      for (let i = 0; i < child.text!.length; i++) {
        text += child.text![i];
        positions.push(contentStart + offset + i);
      }
    } else {
      text += "￼";
      positions.push(contentStart + offset);
    }
  });
  const index = text.indexOf(needle);
  if (index < 0) return null;
  return { from: positions[index]!, to: positions[index + needle.length - 1]! + 1 };
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Runs a transform against the doc's current content and writes the diff back. */
export function transformDoc(doc: Y.Doc, origin: unknown, fn: (tr: Transform) => void): boolean {
  const fragment = fragmentOf(doc);
  const tr = new Transform(yXmlFragmentToProseMirrorRootNode(fragment, pmSchema()));
  fn(tr);
  if (!tr.docChanged) return false;
  doc.transact(() => {
    updateYFragment(doc, fragment, tr.doc, { mapping: new Map(), isOMark: new Map() } as never);
  }, origin);
  return true;
}

export function applyEdits(doc: Y.Doc, ops: EditOp[], origin: unknown): EditResult {
  const touched: string[] = [];
  const changed = transformDoc(doc, origin, (tr) => {
    ensureNonEmpty(tr);
    for (const op of ops) applyOp(tr, op, touched);
  });
  return { touched: [...new Set(touched)], changed };
}

/** Replaces the whole page with Markdown; Markdown with no blocks leaves one empty paragraph. */
export function replaceContent(doc: Y.Doc, markdown: string, origin: unknown): EditResult {
  if (markdownToBlocks(markdown).length) return applyEdits(doc, [{ op: "replace_all", markdown }], origin);
  const changed = transformDoc(doc, origin, (tr) => {
    ensureNonEmpty(tr);
    const { start, end } = topGroup(tr.doc);
    tr.replaceWith(start, end, emptyContainers());
  });
  return { touched: [], changed };
}

function ensureNonEmpty(tr: Transform): void {
  // A doc that was never opened in an editor has no blockGroup yet.
  if (tr.doc.childCount === 0 || tr.doc.firstChild!.childCount === 0) {
    const root = _blocksToProsemirrorNode(serverEditor(), [{ type: "paragraph" }] as never) as unknown as PMNode;
    tr.replaceWith(0, tr.doc.content.size, root.content);
    return;
  }
}

/** Restores the document fragment to a saved state as a normal (undoable by diff) edit. */
export function restoreFromState(doc: Y.Doc, state: Uint8Array, origin: unknown): boolean {
  const saved = new Y.Doc();
  Y.applyUpdate(saved, state);
  const node = yXmlFragmentToProseMirrorRootNode(fragmentOf(saved), pmSchema());
  saved.destroy();
  return transformDoc(doc, origin, (tr) => {
    tr.replaceWith(0, tr.doc.content.size, node.content);
  });
}

// ---------------------------------------------------------------------------
// Comment marks

export function addCommentMark(doc: Y.Doc, ref: string, threadId: string, quote: string | undefined, origin: unknown): string {
  let blockId = "";
  transformDoc(doc, origin, (tr) => {
    const target = findBlock(tr.doc, ref);
    const content = target.node.firstChild!;
    if (!content.isTextblock || content.content.size === 0) {
      throw new PageEditError(`Block ${shortId(target.id)} has no text to comment on.`);
    }
    const range = quote
      ? findText(content, target.pos + 2, quote)
      : { from: target.pos + 2, to: target.pos + 2 + content.content.size };
    if (!range) throw new PageEditError(`Text "${truncate(quote!, 60)}" not found in block ${shortId(target.id)}.`);
    tr.addMark(range.from, range.to, tr.doc.type.schema.marks.comment!.create({ threadId }));
    blockId = target.id;
  });
  return blockId;
}

/** The text each comment thread is anchored to, and the block holding it. */
export function commentAnchors(doc: Y.Doc): Map<string, { blockId: string; text: string }> {
  const root = yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), pmSchema());
  const anchors = new Map<string, { blockId: string; text: string }>();
  for (const block of blockContainers(root)) {
    const content = block.node.firstChild;
    if (!content?.isTextblock) continue;
    content.forEach((child) => {
      for (const mark of child.marks) {
        if (mark.type.name !== "comment") continue;
        const threadId = String(mark.attrs.threadId);
        const anchor = anchors.get(threadId) ?? { blockId: block.id, text: "" };
        if (anchor.blockId === block.id) anchor.text += child.isText ? child.text : "";
        anchors.set(threadId, anchor);
      }
    });
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Presence

/** Finds the Y element for a block, for anchoring an agent's cursor. */
export function blockTextType(doc: Y.Doc, blockId: string): Y.XmlText | Y.XmlElement | null {
  const walk = (parent: Y.XmlFragment | Y.XmlElement): Y.XmlText | Y.XmlElement | null => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) {
        const content = child.get(0);
        if (content instanceof Y.XmlElement) {
          const text = content.get(0);
          return text instanceof Y.XmlText ? text : content;
        }
        return child;
      }
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(fragmentOf(doc));
}

export function blockIds(doc: Y.Doc): string[] {
  const root = yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), pmSchema());
  return blockContainers(root).map((block) => block.id);
}

/** Every mention inline node in the doc, with the block it sits in. */
export function mentionsIn(doc: Y.Doc): { blockId: string; kind: string; target: string; label: string; text: string }[] {
  const root = yXmlFragmentToProseMirrorRootNode(fragmentOf(doc), pmSchema());
  const out: { blockId: string; kind: string; target: string; label: string; text: string }[] = [];
  for (const block of blockContainers(root)) {
    const content = block.node.firstChild;
    if (!content?.isTextblock) continue;
    content.forEach((child) => {
      if (child.type.name === "mention") {
        out.push({
          blockId: block.id,
          kind: String(child.attrs.kind),
          target: String(child.attrs.target),
          label: String(child.attrs.label),
          text: content.textContent,
        });
      }
    });
  }
  return out;
}
