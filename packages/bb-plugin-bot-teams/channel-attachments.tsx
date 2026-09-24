import * as Dialog from "@radix-ui/react-dialog";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Attachment } from "./contract";
import { Button } from "./components/ui/button";

export const attachmentUrl = (a: Attachment, inline = false) =>
  `/api/v1/plugins/bot-teams/http/attachment?id=${encodeURIComponent(a.id)}${inline ? "&inline=1" : ""}`;
const url = attachmentUrl;

export function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: Attachment | null;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={!!attachment}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="channel-dialog-overlay" />
        <Dialog.Content
          className="channel-image-viewer"
          aria-describedby={undefined}
        >
          <header>
            <Dialog.Title>{attachment?.name}</Dialog.Title>
            <a
              href={attachment ? url(attachment) : undefined}
              download={attachment?.name}
            >
              Download
            </a>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close image">
                <Icon name="X" />
              </Button>
            </Dialog.Close>
          </header>
          {attachment && (
            <img
              src={url(attachment, true)}
              alt={attachment.alt || attachment.name}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
