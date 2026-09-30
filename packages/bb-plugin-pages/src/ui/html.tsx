// HTML blocks: the source renders in a sandboxed iframe and is edited in
// BlockNote's source popup (click the block's label, or Enter on it), like
// Mermaid diagrams.
import { createReactBlockSpec, SourceBlockWithPreview } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { htmlConfig } from "../schema-config";
import { plainSource } from "./mermaid";
import { useDarkMode } from "./shared";

export const HTML_HEIGHT_MESSAGE = "bb-pages-html-height";
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2400;

// Reports the document's height to the page, so the frame fits its content,
// and opts HTML without its own color-scheme into BB's light or dark theme.
const FRAME_SCRIPT = `<script>(function(){var root=document.documentElement;if(getComputedStyle(root).colorScheme==="normal")root.style.colorScheme="light dark";var post=function(){parent.postMessage({type:"${HTML_HEIGHT_MESSAGE}",height:Math.ceil(root.getBoundingClientRect().height)},"*")};var observer=new ResizeObserver(post);observer.observe(root);if(document.body)observer.observe(document.body);addEventListener("load",post);post()})()</script>`;

/** The iframe document: the block's HTML plus the height reporter. */
export function htmlSrcDoc(source: string): string {
  return `${source}\n${FRAME_SCRIPT}`;
}

export const clampHeight = (height: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));

/**
 * Same isolation as artifact embeds: scripts run, but in an opaque origin
 * with no access to BB, its cookies or storage, and no popups or navigation.
 */
function HtmlFrame({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const dark = useDarkMode();
  const [height, setHeight] = useState(MIN_HEIGHT * 2);
  // Typing in the source popup re-renders; wait for a pause.
  const [shown, setShown] = useState(source);
  useEffect(() => {
    const timer = setTimeout(() => setShown(source), 300);
    return () => clearTimeout(timer);
  }, [source]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type !== HTML_HEIGHT_MESSAGE || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
      setHeight(clampHeight(data.height));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      title="HTML block"
      srcDoc={htmlSrcDoc(shown)}
      sandbox="allow-scripts"
      loading="lazy"
      // The frame's prefers-color-scheme follows this, so HTML can match BB's theme.
      style={{ height, colorScheme: dark ? "dark" : "light" }}
      className="block w-full border-0 bg-transparent"
    />
  );
}

export const HtmlBlock = createReactBlockSpec(htmlConfig, {
  meta: { hasPreview: true, hardBreakShortcut: "enter", code: true },
  render: ({ block, editor, contentRef }) => {
    const source = plainSource(block.content);
    return (
      <SourceBlockWithPreview
        block={block}
        editor={editor}
        contentRef={contentRef}
        source={source}
        preview={
          source.trim() ? (
            <div className="pages-html my-1 w-full overflow-hidden rounded-lg border border-border">
              {/* Clicks inside the frame stay there, so this strip opens the source. */}
              <div className="flex h-7 cursor-pointer items-center gap-1.5 border-b border-border bg-card/50 px-2.5 text-xs text-muted-foreground hover:text-foreground">
                <Icon name="Code" className="size-3.5" />
                HTML
                {editor.isEditable ? <span className="ml-auto">Edit source</span> : null}
              </div>
              <HtmlFrame source={source} />
            </div>
          ) : undefined
        }
        emptySourcePlaceholder="Add HTML"
        sourcePlaceholder="<div>Hello</div>"
      />
    );
  },
});
