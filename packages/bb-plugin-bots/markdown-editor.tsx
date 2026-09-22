import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Annotation } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
  undoDepth,
  redoDepth,
  isolateHistory,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { IconActionTooltip } from "./channel-controls";
import {
  wrapMarkdown,
  prefixMarkdown,
  insertMarkdownLink,
} from "./markdown-commands";

const externalValue = Annotation.define<boolean>();
const highlighting = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "600", color: "var(--foreground)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: [tags.url, tags.link],
    color: "var(--primary)",
    textDecoration: "underline",
  },
  {
    tag: [tags.processingInstruction, tags.meta],
    color: "var(--muted-foreground)",
  },
  { tag: tags.monospace, backgroundColor: "var(--state-hover)" },
]);
const formats = [
  {
    label: "Bold",
    icon: <strong aria-hidden="true">B</strong>,
    command: wrapMarkdown("**", "bold text"),
  },
  {
    label: "Italic",
    icon: <em aria-hidden="true">I</em>,
    command: wrapMarkdown("*", "italic text"),
  },
  {
    label: "Heading",
    icon: <span aria-hidden="true">H₂</span>,
    command: prefixMarkdown("## "),
  },
  {
    label: "Bullet list",
    icon: <Icon name="ListView" />,
    command: prefixMarkdown("- "),
  },
  {
    label: "Insert link",
    icon: (
      <svg
        aria-hidden="true"
        data-icon-root=""
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2" />
      </svg>
    ),
    command: insertMarkdownLink,
  },
] as const;

export function MarkdownEditor({
  id,
  label,
  value,
  disabled,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const [preview, setPreview] = useState(false);
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });
  const [editable] = useState(() => new Compartment());
  useEffect(() => {
    const editor = new EditorView({
      parent: container.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          syntaxHighlighting(highlighting),
          search({ top: true }),
          keymap.of([
            { key: "Mod-b", run: formats[0].command },
            { key: "Mod-i", run: formats[1].command },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          editable.of([
            EditorState.readOnly.of(disabled),
            EditorView.editable.of(!disabled),
          ]),
          EditorView.contentAttributes.of({
            id,
            "aria-label": label,
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((t) => t.annotation(externalValue))
            ) {
              callbacks.current.onChange(update.state.doc.toString());
            }
            if (update.docChanged)
              setDepth({
                undo: undoDepth(update.state),
                redo: redoDepth(update.state),
              });
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [id, label, editable]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: [externalValue.of(true), isolateHistory.of("full")],
      });
    }
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    });
  }, [disabled, editable]);
  useEffect(() => {
    if (!preview) view.current?.requestMeasure();
  }, [preview]);
  const run = (command: (editor: EditorView) => boolean) => {
    if (!view.current || disabled || preview) return;
    command(view.current);
    view.current.focus();
  };
  return (
    <div
      className="bot-markdown-editor"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          callbacks.current.onSave();
        }
      }}
    >
      <div className="bot-markdown-header">
        <span className="bot-markdown-filename">{label}</span>
        <div
          className="bot-markdown-modes"
          role="group"
          aria-label="Document view"
        >
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Preview
          </Button>
        </div>
      </div>
      <div
        className="bot-markdown-tools"
        role="group"
        aria-label="Markdown tools"
        hidden={preview}
      >
        {formats.map((format) => (
          <IconActionTooltip key={format.label} label={format.label}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={format.label}
              disabled={disabled}
              onClick={() => run(format.command)}
            >
              {format.icon}
            </Button>
          </IconActionTooltip>
        ))}
        <span className="bot-markdown-tools-spacer" />
        <IconActionTooltip label="Undo">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Undo"
            disabled={disabled || !depth.undo}
            onClick={() => run(undo)}
          >
            <Icon name="ArrowTurnBackward" />
          </Button>
        </IconActionTooltip>
        <IconActionTooltip label="Redo">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Redo"
            disabled={disabled || !depth.redo}
            onClick={() => run(redo)}
          >
            <Icon name="ArrowTurnForward" />
          </Button>
        </IconActionTooltip>
        <IconActionTooltip label="Find and replace">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Find and replace"
            disabled={disabled}
            onClick={() => {
              if (view.current) openSearchPanel(view.current);
            }}
          >
            <Icon name="Search" />
          </Button>
        </IconActionTooltip>
      </div>
      <div ref={container} className="bot-markdown-source" hidden={preview} />
      {preview && (
        <div
          className="bot-markdown-preview"
          role="region"
          aria-label={`${label} preview`}
          tabIndex={0}
        >
          {value.trim() ? (
            <Markdown content={value} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing to preview yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
