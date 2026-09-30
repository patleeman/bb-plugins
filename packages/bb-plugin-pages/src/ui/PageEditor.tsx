import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu, SyntaxHighlightingExtension } from "@blocknote/core";
import { CommentsExtension, DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { withCollaboration, YjsThreadStore } from "@blocknote/core/yjs";
import {
  BlockNoteViewEditor,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  ThreadsSidebar,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/shadcn/style.css";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";
import { HUMAN_USER_ID, MAX_UPLOAD_BYTES, PLUGIN_ID, UPLOAD_PATH } from "../constants";
import type { BotView, PageMetaView } from "../contract";
import { DOCUMENT_FRAGMENT, STUDIO_EMBEDS, THREADS_MAP, type StudioEmbedKind } from "../schema-config";
import { linkEmbed } from "./links";
import { pageSchema } from "./blocks";
import { createHighlighter } from "./code";
import type { PageConnection } from "./connection";
import { authorInfo, usePagesUi } from "./context";
import { useDarkMode } from "./shared";
import {
  dictationParagraphs,
  pageFieldKey,
  pageFieldLabel,
  spacedAfter,
  TALK_FIELD_ATTR,
  TALK_FIELD_LABEL_ATTR,
  TALK_INSERT_EVENT,
  toggleTalk,
} from "./talk";

const HUMAN_COLOR = "#2563eb";

const STUDIO_EMBED_SUBTEXT: Record<StudioEmbedKind, string> = {
  drawing: "Embed an Excalidraw drawing",
  artifact: "Embed an artifact: image, HTML, PDF or text",
  recording: "Embed a Talk recording",
  task: "Embed a Studio task",
};
const STUDIO_EMBED_ICONS: Record<StudioEmbedKind, string> = { drawing: "Palette", artifact: "File", recording: "Mic", task: "CircleCheck" };

export type SidePanel = "comments" | null;

function avatarUrl(label: string, background: string): string {
  const glyph = [...label.trim()][0] ?? "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${background}"/><text x="32" y="42" font-size="30" text-anchor="middle" font-family="system-ui,sans-serif" fill="white">${glyph.replace(/[<&>"]/g, "")}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function uploadFile(pageId: string, file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Files are limited to 15 MB.");
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < buffer.length; index += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  }
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/http${UPLOAD_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageId, name: file.name, mime: file.type, dataBase64: btoa(binary) }),
  });
  const result = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !result.url) throw new Error(result.error ?? `Upload failed (${response.status}).`);
  return result.url;
}

function isoDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function nextWeekday(target: number): number {
  const day = new Date().getDay();
  return ((target - day + 7) % 7) || 7;
}

// BlockNote's suggestion menu keys group labels by group name and items by
// title, so a group must be contiguous and titles unique within one list.
function mergeGroups(base: DefaultReactSuggestionItem[], extra: DefaultReactSuggestionItem[]): DefaultReactSuggestionItem[] {
  const items = [...base];
  for (const item of extra) {
    let last = -1;
    items.forEach((candidate, index) => {
      if (candidate.group === item.group) last = index;
    });
    if (last < 0) items.push(item);
    else items.splice(last + 1, 0, item);
  }
  return items;
}

function uniqueTitles(items: DefaultReactSuggestionItem[]): DefaultReactSuggestionItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = seen.get(item.title) ?? 0;
    seen.set(item.title, count + 1);
    return count ? { ...item, title: `${item.title} (${count + 1})` } : item;
  });
}

export function PageEditor({
  connection,
  page,
  bots,
  pages,
  sidePanel,
  onCloseSidePanel,
}: {
  connection: PageConnection;
  page: PageMetaView;
  bots: BotView[];
  pages: PageMetaView[];
  sidePanel: SidePanel;
  onCloseSidePanel(): void;
}) {
  const sdk = useSdk();
  const ui = usePagesUi();
  const dark = useDarkMode();
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const threadStore = useMemo(
    () =>
      new YjsThreadStore(
        HUMAN_USER_ID,
        connection.doc.getMap(THREADS_MAP),
        new DefaultThreadStoreAuth(HUMAN_USER_ID, "editor"),
      ),
    [connection],
  );

  const openThreads = useSyncExternalStore(
    useCallback((onChange: () => void) => threadStore.subscribe(onChange), [threadStore]),
    () => {
      let count = 0;
      for (const thread of threadStore.getThreads().values()) if (!thread.resolved && !thread.deletedAt) count += 1;
      return count;
    },
  );

  const editor = useCreateBlockNote(
    withCollaboration({
      schema: pageSchema,
      collaboration: {
        fragment: connection.doc.getXmlFragment(DOCUMENT_FRAGMENT),
        user: { name: "You", color: HUMAN_COLOR },
        provider: { awareness: connection.awareness },
        showCursorLabels: "activity",
      },
      extensions: [
        SyntaxHighlightingExtension({ createHighlighter }),
        CommentsExtension({
          threadStore,
          resolveUsers: async (ids: string[]) =>
            ids.map((id) => {
              const info = authorInfo(id, botsRef.current);
              return {
                id,
                username: info.name,
                avatarUrl: avatarUrl(info.avatar || info.name, id === HUMAN_USER_ID ? HUMAN_COLOR : "#7c3aed"),
              };
            }),
        }),
      ],
      uploadFile: (file: File) => uploadFile(page.id, file),
      // BlockNote eases nesting changes over 0.3s, which makes Tab feel slow.
      animations: false,
      pasteHandler: ({ event, editor, defaultPasteHandler }) => {
        const embed = linkEmbed(event.clipboardData?.getData("text/plain") ?? "", window.location.origin);
        const block = editor.getTextCursorPosition().block;
        if (!embed || block.type !== "paragraph" || !Array.isArray(block.content) || block.content.length > 0) return defaultPasteHandler();
        editor.updateBlock(block, { type: "embed", props: embed });
        const [next] = editor.insertBlocks([{ type: "paragraph" }], block, "after");
        if (next) editor.setTextCursorPosition(next, "start");
        return true;
      },
    }),
    [connection, threadStore],
  );

  const slashItems = useMemo(() => {
    const custom: DefaultReactSuggestionItem[] = [
      {
        title: "Callout",
        subtext: "Highlight a note, tip or warning",
        aliases: ["note", "tip", "warning", "info"],
        group: "Basic blocks",
        icon: <Icon name="Info" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "callout" }),
      },
      {
        title: "Mermaid diagram",
        subtext: "Flowchart, sequence, Gantt and more",
        aliases: ["mermaid", "diagram", "flowchart", "sequence", "gantt"],
        group: "Advanced",
        icon: <Icon name="Workflow" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "mermaid" }),
      },
      {
        title: "HTML",
        subtext: "Custom HTML, CSS and scripts in a sandboxed frame",
        aliases: ["html", "iframe", "widget", "custom"],
        group: "Advanced",
        icon: <Icon name="Code" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "html" }),
      },
      {
        title: "Chart",
        subtext: "Bar, line, area or pie chart from data",
        aliases: ["graph", "plot", "bar", "line", "pie"],
        group: "Data",
        icon: <Icon name="ChartColumn" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "chart" }),
      },
      {
        title: "Stats",
        subtext: "A row of key numbers",
        aliases: ["metrics", "kpi", "numbers"],
        group: "Data",
        icon: <Icon name="GridView" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "stats" }),
      },
      {
        title: "Link preview",
        subtext: "Embed a link as a card",
        aliases: ["bookmark", "embed", "url"],
        group: "Media",
        icon: <Icon name="ExternalLink" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "embed", props: { kind: "bookmark" } }),
      },
      {
        title: "Page link",
        subtext: "Embed another page as a card",
        aliases: ["subpage", "embed page"],
        group: "Media",
        icon: <Icon name="FileText" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "embed", props: { kind: "page" } }),
      },
      {
        title: "Thread",
        subtext: "Embed a BB thread as a card",
        aliases: ["chat", "conversation"],
        group: "Media",
        icon: <Icon name="MessageSquare" className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "embed", props: { kind: "thread" } }),
      },
      ...(Object.keys(STUDIO_EMBEDS) as StudioEmbedKind[]).map((kind) => ({
        title: STUDIO_EMBEDS[kind].label,
        subtext: STUDIO_EMBED_SUBTEXT[kind],
        aliases: [kind, STUDIO_EMBEDS[kind].pluginId, "studio", "embed"],
        group: "Studio",
        icon: <Icon name={STUDIO_EMBED_ICONS[kind]} className="size-4" />,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "embed", props: { kind } }),
      })),
    ];
    return mergeGroups(getDefaultReactSlashMenuItems(editor), custom);
  }, [editor]);

  const fieldKey = pageFieldKey(page.id);
  const slashMenuItems = useCallback(
    async (query: string) => {
      // Offered only while Talk is installed and loaded.
      const talk = document.documentElement.dataset.bbTalk
        ? [
            {
              title: "Dictate",
              subtext: "Speak and Talk types it here",
              aliases: ["talk", "voice", "speak", "transcribe", "mic"],
              group: "Talk",
              icon: <Icon name="Mic" className="size-4" />,
              onItemClick: () => void toggleTalk(fieldKey),
            },
          ]
        : [];
      return filterSuggestionItems([...slashItems, ...talk], query);
    },
    [slashItems, fieldKey],
  );

  // Talk dictates at the cursor. Before the user has put the cursor in the
  // page, a dictation goes at the end instead of the top.
  const fieldRef = useRef<HTMLDivElement>(null);
  const cursorPlaced = useRef(false);
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const onInsert = (event: Event) => {
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      const paragraphs = typeof text === "string" && editor.isEditable ? dictationParagraphs(text) : [];
      if (!paragraphs.length) return;
      event.preventDefault();
      if (!cursorPlaced.current) {
        const last = editor.document[editor.document.length - 1];
        if (last?.type === "paragraph" && Array.isArray(last.content) && last.content.length === 0) {
          editor.setTextCursorPosition(last, "end");
        } else if (last) {
          const inserted = editor.insertBlocks(
            paragraphs.map((paragraph) => ({ type: "paragraph" as const, content: paragraph })),
            last,
            "after",
          );
          editor.setTextCursorPosition(inserted[inserted.length - 1]!, "end");
          cursorPlaced.current = true;
          return;
        }
        cursorPlaced.current = true;
      }
      const inline = editor.transact((tr) => {
        const { $from, from, to } = tr.selection;
        if (!$from.parent.isTextblock) return false;
        tr.insertText(spacedAfter($from.parent.textBetween(0, $from.parentOffset, undefined, " "), paragraphs[0]!), from, to);
        return true;
      });
      const rest = inline ? paragraphs.slice(1) : paragraphs;
      if (!rest.length) return;
      const inserted = editor.insertBlocks(
        rest.map((paragraph) => ({ type: "paragraph" as const, content: paragraph })),
        editor.getTextCursorPosition().block,
        "after",
      );
      editor.setTextCursorPosition(inserted[inserted.length - 1]!, "end");
    };
    field.addEventListener(TALK_INSERT_EVENT, onInsert);
    return () => field.removeEventListener(TALK_INSERT_EVENT, onInsert);
  }, [editor]);

  const mentionItems = useCallback(async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const insert = (kind: string, target: string, label: string) => () => {
      editor.insertInlineContent([{ type: "mention", props: { kind, target, label } } as never, " "]);
    };
    const botItems = botsRef.current.map((bot) => ({
      title: bot.name,
      subtext: bot.description || `@${bot.handle}`,
      aliases: [bot.handle],
      group: "Bots",
      icon: <span className="text-base leading-none">{bot.avatar}</span>,
      onItemClick: insert("bot", bot.id, bot.name),
    }));
    const pageItems = pagesRef.current
      .filter((candidate) => candidate.id !== page.id && !candidate.archived)
      .map((candidate) => ({
        title: candidate.title || "Untitled",
        group: "Pages",
        icon: candidate.icon ? <span className="text-base leading-none">{candidate.icon}</span> : <Icon name="FileText" className="size-4" />,
        onItemClick: insert("page", candidate.id, candidate.title || "Untitled"),
      }));
    const dates = [
      { title: "Today", offset: 0 },
      { title: "Tomorrow", offset: 1 },
      { title: "Next Monday", offset: nextWeekday(1) },
      { title: "Next Friday", offset: nextWeekday(5) },
    ].map(({ title, offset }) => {
      const iso = isoDate(offset);
      return { title, subtext: iso, aliases: [iso, "date"], group: "Dates", icon: <Icon name="Calendar" className="size-4" />, onItemClick: insert("date", iso, iso) };
    });
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.trim())) {
      dates.unshift({
        title: query.trim(),
        subtext: "Date",
        aliases: [],
        group: "Dates",
        icon: <Icon name="Calendar" className="size-4" />,
        onItemClick: insert("date", query.trim(), query.trim()),
      });
    }
    let threadItems: DefaultReactSuggestionItem[] = [];
    if (query.trim().length >= 2) {
      try {
        const threads = (await sdk.threads.list({ projectId: page.projectId ?? undefined, limit: 50 })) as {
          id: string;
          title?: string | null;
        }[];
        threadItems = threads
          .filter((thread) => thread.title)
          .map((thread) => ({
            title: thread.title!,
            group: "Threads",
            icon: <Icon name="MessageSquare" className="size-4" />,
            onItemClick: insert("thread", thread.id, thread.title!),
          }));
      } catch {
        // Thread suggestions are optional.
      }
    }
    let studioItems: DefaultReactSuggestionItem[] = [];
    if (query.trim()) {
      try {
        studioItems = (await ui.studioItems()).map((item) => ({
          title: item.title,
          subtext: item.kindLabel,
          group: "Studio",
          icon: item.icon ? <span className="text-base leading-none">{item.icon}</span> : <Icon name={item.kindIcon} className="size-4" />,
          onItemClick: insert("item", `${item.pluginId}:${item.id}`, item.title),
        }));
      } catch {
        // Studio suggestions are optional.
      }
    }
    return uniqueTitles(filterSuggestionItems([...botItems, ...pageItems, ...dates, ...threadItems, ...studioItems], query).slice(0, 30));
  }, [editor, sdk, ui, page.id, page.projectId]);

  return (
    <BlockNoteView
      editor={editor}
      theme={dark ? "dark" : "light"}
      slashMenu={false}
      renderEditor={false}
      className="pages-editor flex min-h-0 min-w-0 flex-1"
    >
      <div
        ref={fieldRef}
        className="pages-main min-w-0 flex-1"
        {...{ [TALK_FIELD_ATTR]: fieldKey, [TALK_FIELD_LABEL_ATTR]: pageFieldLabel(page.title) }}
        onFocus={() => (cursorPlaced.current = true)}
      >
        <BlockNoteViewEditor />
      </div>
      {sidePanel === "comments" ? (
        // A card floating over the page's right edge; a bottom sheet on phones.
        // Positioned against the page view, so no ancestor up to it may be positioned.
        <aside
          aria-label="Comments"
          className="pages-comments absolute top-14 right-3 bottom-3 z-30 flex w-80 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:h-[75%] max-md:w-auto max-md:rounded-b-none"
        >
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-border pr-2 pl-4">
            <span className="text-sm font-medium">Comments</span>
            <button
              type="button"
              aria-label="Close comments"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
              onClick={onCloseSidePanel}
            >
              <Icon name="X" className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {openThreads ? null : (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                No open comments. Select text in the page and choose <span className="text-foreground">Comment</span> to start one.
              </p>
            )}
            <ThreadsSidebar filter="open" sort="position" />
          </div>
        </aside>
      ) : null}
      <SuggestionMenuController triggerCharacter="/" getItems={slashMenuItems} />
      <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
    </BlockNoteView>
  );
}
