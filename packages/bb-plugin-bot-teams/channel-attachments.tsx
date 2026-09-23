import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Attachment } from "./contract";
import { inlineImage } from "./image-format";
import { Button } from "./components/ui/button";

export const attachmentUrl = (a: Attachment, inline = false) =>
  `/api/v1/plugins/bot-teams/http/attachment?id=${encodeURIComponent(a.id)}${inline ? "&inline=1" : ""}`;
const url = attachmentUrl;

export function ChannelAttachments({
  attachments,
  onRemove,
  disabled,
  onImageLoad,
}: {
  attachments: Attachment[];
  onRemove?: (attachment: Attachment) => void;
  disabled?: boolean;
  onImageLoad?: () => void;
}) {
  const [expanded, setExpanded] = useState<Attachment | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  return (
    <>
      <div
        className={`group-attachments${onRemove ? " group-attachments-draft" : ""}`}
      >
        {attachments.map((a) => (
          <div
            key={a.id}
            className={
              inlineImage(a) && !failed.includes(a.id)
                ? "channel-image"
                : "group-attachment"
            }
          >
            {inlineImage(a) && !failed.includes(a.id) ? (
              <button
                type="button"
                className="channel-image-open"
                aria-label={`Expand ${a.name}`}
                onClick={() => setExpanded(a)}
              >
                <img
                  loading="lazy"
                  src={url(a, true)}
                  alt={a.alt || a.name}
                  onLoad={onImageLoad}
                  onError={() => setFailed((ids) => [...ids, a.id])}
                />
              </button>
            ) : (
              <a href={url(a)} download={a.name}>
                <Icon name="Paperclip" />
                <span>{a.name}</span>
                <small>
                  {a.sizeBytes < 1024
                    ? `${a.sizeBytes} B`
                    : `${Math.ceil(a.sizeBytes / 1024)} KB`}
                </small>
              </a>
            )}
            {onRemove && (
              <button
                type="button"
                className="channel-attachment-remove"
                aria-label={`Remove ${a.name}`}
                disabled={disabled}
                onClick={() => onRemove(a)}
              >
                <Icon name="X" />
              </button>
            )}
          </div>
        ))}
      </div>
      <Dialog.Root
        open={!!expanded}
        onOpenChange={(open) => {
          if (!open) setExpanded(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="channel-dialog-overlay" />
          <Dialog.Content
            className="channel-image-viewer"
            aria-describedby={undefined}
          >
            <header>
              <Dialog.Title>{expanded?.name}</Dialog.Title>
              <a
                href={expanded ? url(expanded) : undefined}
                download={expanded?.name}
              >
                Download
              </a>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close image">
                  <Icon name="X" />
                </Button>
              </Dialog.Close>
            </header>
            {expanded && (
              <img
                src={url(expanded, true)}
                alt={expanded.alt || expanded.name}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
