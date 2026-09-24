// Pieces of BB's thread timeline (apps/app thread/timeline and ui), adapted for
// a channel transcript: the hover action row under each message, attachment
// pills and thumbnails, dividers, status rows, and the scroll controls.
import { useEffect, useState, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Attachment } from "./contract";
import { Button } from "./components/ui/button";
import { AttachmentLightbox, attachmentUrl } from "./channel-attachments";
import { inlineImage } from "./image-format";
import { cn } from "./lib/utils";

/** BB's assistant prose column inset (MessageActionBar PROSE_COLUMN_INSET_CLASS). */
export const PROSE_COLUMN_INSET_CLASS = "px-2";

// MessageActionBar.
export const ACTION_BUTTON_CLASS =
  "inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
export const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 data-[state=open]:opacity-100";
const MOBILE_OVERFLOW_ACTION_CLASS = "max-md:pointer-coarse:hidden";
const MOBILE_OVERFLOW_TRIGGER_CLASS =
  "hidden size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground max-md:pointer-coarse:inline-flex max-md:pointer-coarse:[&_[data-icon-root]]:size-4";
const ACTION_ROW_CLASS =
  "absolute top-0 flex max-w-full items-center gap-2 overflow-hidden has-[[data-state=open]]:[&_button]:opacity-100";
const BUBBLE_ALIGN_INSET_CLASS = "pr-[13px] max-md:pointer-coarse:pr-[11px]";
const BUBBLE_ALIGN_OFFSET_CLASS =
  "right-[13px] max-md:pointer-coarse:right-[11px]";
const PROSE_ALIGN_INSET_CLASS = "-ml-1 max-md:pointer-coarse:-ml-1.5";

export type MessageAction = {
  key: string;
  label: string;
  icon: string;
  onSelect: () => void;
  disabled?: boolean;
};

/**
 * BB's MessageActionBar: a reserved row under the message whose icon buttons
 * appear on hover or focus. Coarse pointers get one overflow button instead.
 */
export function MessageActionBar({
  alignment,
  actions,
  leading,
  trailing,
  onOpenMobileMenu,
  className,
}: {
  alignment: "start" | "end";
  actions: MessageAction[];
  /** Host-shaped controls placed first, such as the reaction picker. */
  leading?: ReactNode;
  /** Quiet metadata after the actions, such as the send time. */
  trailing?: ReactNode;
  onOpenMobileMenu: () => void;
  className?: string;
}) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        className={cn(
          "relative w-full h-5 max-md:pointer-coarse:h-7",
          alignment === "end" && BUBBLE_ALIGN_INSET_CLASS,
        )}
      >
        <div
          className={cn(
            ACTION_ROW_CLASS,
            alignment === "end"
              ? BUBBLE_ALIGN_OFFSET_CLASS
              : cn("left-0", PROSE_ALIGN_INSET_CLASS),
            className,
          )}
        >
          {leading}
          {actions.map((action) => (
            <Tooltip.Root key={action.key}>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  className={cn(
                    ACTION_BUTTON_CLASS,
                    HOVER_REVEAL_CLASS,
                    MOBILE_OVERFLOW_ACTION_CLASS,
                  )}
                  onClick={action.onSelect}
                  disabled={action.disabled}
                  aria-label={action.label}
                >
                  <Icon name={action.icon} className="size-3" />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="bottom"
                  sideOffset={4}
                  collisionPadding={8}
                  className="z-50 max-w-[min(20rem,var(--radix-tooltip-content-available-width))] overflow-hidden break-words rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                >
                  {action.label}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          ))}
          {trailing ? (
            <span
              className={cn(
                "whitespace-nowrap text-2xs text-subtle-foreground",
                HOVER_REVEAL_CLASS,
                MOBILE_OVERFLOW_ACTION_CLASS,
              )}
            >
              {trailing}
            </span>
          ) : null}
          <button
            type="button"
            className={MOBILE_OVERFLOW_TRIGGER_CLASS}
            aria-label="Message actions"
            data-no-sidebar-swipe=""
            onClick={onOpenMobileMenu}
          >
            <Icon name="MoreHorizontal" className="size-3" />
          </button>
        </div>
      </div>
    </Tooltip.Provider>
  );
}

/** BB's ConversationAttachments: image thumbnails, then file pills. */
export function MessageAttachments({
  attachments,
  align,
  onImageLoad,
}: {
  attachments: Attachment[];
  align: "start" | "end";
  onImageLoad?: () => void;
}) {
  const [expanded, setExpanded] = useState<Attachment | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const isImage = (a: Attachment) => inlineImage(a) && !failed.includes(a.id);
  const images = attachments.filter(isImage);
  const files = attachments.filter((a) => !isImage(a));
  if (!attachments.length) return null;
  const justify = align === "end" ? "justify-end" : "justify-start";
  const tone =
    align === "end"
      ? "border-surface-selected-border bg-surface-raised"
      : "border-border bg-surface-recessed";
  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 ? (
        <div className={cn("flex flex-wrap gap-2", justify)}>
          {images.map((image) => (
            <button
              type="button"
              key={image.id}
              className={cn(
                "channel-image cursor-zoom-in overflow-hidden rounded-md border",
                tone,
              )}
              onClick={() => setExpanded(image)}
              title={image.alt || image.name}
              aria-label={`Expand ${image.name}`}
            >
              <img
                src={attachmentUrl(image, true)}
                alt={image.alt || image.name}
                // A bot's published image is its answer, so it keeps a
                // readable size where BB would show a thumbnail.
                className={cn(
                  "block",
                  align === "end"
                    ? "h-20 max-w-36 object-cover"
                    : "max-h-80 max-w-full object-contain",
                )}
                loading="lazy"
                decoding="async"
                onLoad={onImageLoad}
                onError={() => setFailed((ids) => [...ids, image.id])}
              />
            </button>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1.5", justify)}>
          {files.map((file) => (
            <a
              key={file.id}
              href={attachmentUrl(file)}
              download={file.name}
              className={cn(
                "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground no-underline hover:bg-state-hover",
                tone,
              )}
              title={`${file.name} · ${formatSize(file.sizeBytes)}`}
            >
              <span className="truncate">{file.name}</span>
            </a>
          ))}
        </div>
      ) : null}
      <AttachmentLightbox
        attachment={expanded}
        onClose={() => setExpanded(null)}
      />
    </div>
  );
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`;

/** BB's TimelineUnreadDivider, in the muted tone for a date. */
export function DayDivider({ time }: { time: number }) {
  return (
    <div
      role="separator"
      aria-label={new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
      }).format(time)}
      className="channel-date flex items-center gap-2 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground"
    >
      <span className="shrink-0">
        {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
          time,
        )}
      </span>
      <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
    </div>
  );
}

/** BB's static timeline row: a muted one-line event with a leading icon. */
export function TimelineSystemRow({
  icon,
  children,
  className,
}: {
  icon: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 px-2 text-sm leading-5 text-muted-foreground",
        className,
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** BB's LoadOlderMessages button. */
export function LoadMessagesButton({
  direction,
  loading,
  onClick,
}: {
  direction: "older" | "newer";
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={cn(
        "flex justify-center",
        direction === "older" ? "mb-3 pt-2" : "mt-3 pb-2",
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={loading}
        aria-label={
          direction === "older" ? "Load earlier messages" : "Load newer messages"
        }
      >
        <Icon
          name={direction === "older" ? "ChevronUp" : "ChevronDown"}
          aria-hidden
        />
        {loading
          ? "Loading messages…"
          : direction === "older"
            ? "Load older messages"
            : "Load newer messages"}
      </Button>
    </div>
  );
}

/** BB's ScrollToBottomButton, floating just above the composer. */
export function ScrollToBottomButton({
  visible,
  active = false,
  label = "Jump to latest",
  onClick,
}: {
  visible: boolean;
  active?: boolean;
  label?: string;
  onClick: () => void;
}) {
  // Keep the button mounted while it fades out.
  const [present, setPresent] = useState(visible);
  useEffect(() => {
    if (visible) setPresent(true);
    else {
      const timer = setTimeout(() => setPresent(false), 200);
      return () => clearTimeout(timer);
    }
  }, [visible]);
  if (!present && !visible) return null;
  return (
    <div className="channel-latest flex h-0 items-center justify-center">
      <button
        onClick={onClick}
        className={cn(
          "z-20 -mt-20 flex size-8 cursor-pointer items-center justify-center rounded-full border border-border bg-background transition-all duration-200 hover:bg-accent",
          visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none invisible translate-y-2 opacity-0",
        )}
        aria-label={label}
        type="button"
      >
        <Icon
          name="ArrowDown"
          className={cn("size-4", active && visible && "animate-shine-icon")}
        />
      </button>
    </div>
  );
}
