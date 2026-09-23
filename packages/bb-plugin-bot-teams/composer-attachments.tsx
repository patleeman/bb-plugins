// BB's AttachmentPreview (apps/app promptbox): image thumbnails, then file
// pills, beneath the editor.
import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Attachment } from "./contract";
import { AttachmentLightbox, attachmentUrl } from "./channel-attachments";
import { inlineImage } from "./image-format";

export function AttachmentPreview({
  attachments,
  onRemoveAttachment,
}: {
  attachments: Attachment[];
  onRemoveAttachment?: (attachment: Attachment) => void;
}) {
  const [expanded, setExpanded] = useState<Attachment | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const isImage = (a: Attachment) => inlineImage(a) && !failed.includes(a.id);
  const imageAttachments = attachments.filter(isImage);
  const nonImageAttachments = attachments.filter((a) => !isImage(a));

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="mx-3 mb-1 mt-1">
        {imageAttachments.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {imageAttachments.map((attachment) => (
              <div key={attachment.id} className="relative">
                <button
                  type="button"
                  className="cursor-zoom-in overflow-hidden rounded-md border border-border bg-surface-recessed"
                  onClick={() => setExpanded(attachment)}
                  title={attachment.name}
                >
                  <img
                    src={attachmentUrl(attachment, true)}
                    alt={attachment.alt || attachment.name}
                    className="h-16 w-24 object-cover"
                    loading="lazy"
                    decoding="async"
                    onError={() =>
                      setFailed((ids) => [...ids, attachment.id])
                    }
                  />
                </button>
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment)}
                    className="absolute right-1 top-1 z-10 rounded-full bg-black/55 p-0.5 text-white transition-colors hover:bg-black/70"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <Icon name="X" className="size-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {nonImageAttachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {nonImageAttachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-recessed px-2 py-0.5 text-xs text-muted-foreground"
              >
                <span className="truncate">{attachment.name}</span>
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment)}
                    className="rounded p-0.5 hover:bg-state-hover"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <Icon name="X" className="size-3" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <AttachmentLightbox
        attachment={expanded}
        onClose={() => setExpanded(null)}
      />
    </>
  );
}
