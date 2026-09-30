import {
  BlockNoteEditor,
  BlockNoteSchema,
  createBlockSpec,
  createInlineContentSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { CommentsExtension, DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { YjsThreadStore } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { calloutConfig, chartConfig, embedConfig, htmlConfig, mentionConfig, mermaidConfig, statsConfig } from "./schema-config";

// The server never renders blocks; these specs only contribute their configs
// to the ProseMirror schema so server-side edits produce the same nodes the
// editor does. Rendering is only reached by HTML export, which we don't use.
const noRender = () => ({ dom: { nodeType: 1 } as unknown as HTMLElement });

export const serverSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: createBlockSpec(calloutConfig, { render: noRender })(),
    chart: createBlockSpec(chartConfig, { render: noRender })(),
    stats: createBlockSpec(statsConfig, { render: noRender })(),
    embed: createBlockSpec(embedConfig, { render: noRender })(),
    mermaid: createBlockSpec(mermaidConfig, { render: noRender })(),
    html: createBlockSpec(htmlConfig, { render: noRender })(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: createInlineContentSpec(mentionConfig, { render: noRender as never }),
  },
});

export type PageSchema = typeof serverSchema;
export type PageEditor = BlockNoteEditor<
  PageSchema["blockSchema"],
  PageSchema["inlineContentSchema"],
  PageSchema["styleSchema"]
>;

/**
 * A headless editor whose ProseMirror schema includes the comment mark. It is
 * used for conversions only and never bound to a document.
 */
export function createServerEditor(): PageEditor {
  const holder = new Y.Doc();
  const threadStore = new YjsThreadStore(
    "server",
    holder.getMap("threads"),
    new DefaultThreadStoreAuth("server", "editor"),
  );
  return BlockNoteEditor.create({
    schema: serverSchema,
    extensions: [CommentsExtension({ threadStore, resolveUsers: async () => [] })],
  }) as unknown as PageEditor;
}
