import { useId, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Room } from "./contract";
import { IconActionTooltip } from "./channel-controls";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./components/ui/context-menu";

function openOptions(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    }),
  );
}

export function ChannelSidebarRow({
  room,
  selected,
  working,
  attentionCount = 0,
  pending,
  onOpen,
  onRename,
  onCopyId,
  onArchive,
  onDelete,
}: {
  room: Room;
  selected: boolean;
  working: boolean;
  attentionCount?: number;
  pending: boolean;
  onOpen: () => void;
  onRename: () => void;
  onCopyId: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const unread = room.updatedAt > (room.lastReadAt ?? 0) && !selected;
  const archiveLabel = room.archived ? "Restore channel" : "Archive channel";
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          className="channel-sidebar-row"
          data-selected={selected || undefined}
          onKeyDown={(event) => {
            if (
              event.key !== "ContextMenu" &&
              !(event.shiftKey && event.key === "F10")
            )
              return;
            event.preventDefault();
            openOptions(event.target as HTMLElement);
          }}
        >
          <button
            type="button"
            className={`channel-nav-row ${unread ? "is-unread" : ""}`}
            aria-current={selected ? "page" : undefined}
            onClick={onOpen}
          >
            {attentionCount > 0 ? (
              <span className="channel-needs-attention" role="img"
                aria-label={`${attentionCount} ${attentionCount === 1 ? "request needs" : "requests need"} your attention`}
                title={`${attentionCount} ${attentionCount === 1 ? "request needs" : "requests need"} your attention`}>
                <Icon name="BellDot" />
              </span>
            ) : room.pinned ? (
              <Icon name="Pin" />
            ) : (
              <span className="channel-hash" aria-hidden>
                #
              </span>
            )}
            <span className="channel-nav-name">{room.name}</span>
            {room.archived && <span className="channel-nav-archived">Archived</span>}
            {(working || unread) && (
              <span className="channel-nav-status">
                {working ? (
                  <span
                    className="channel-working"
                    role="img"
                    aria-label="Channel working"
                    title="Channel working"
                  >
                    <Icon name="Loading" />
                  </span>
                ) : (
                  <span className="channel-unread-dot" aria-label="Unread" />
                )}
              </span>
            )}
          </button>
          <span className="channel-nav-actions">
            <IconActionTooltip label={archiveLabel}>
              <button
                type="button"
                className="channel-nav-action channel-nav-archive"
                aria-label={`${archiveLabel}: ${room.name}`}
                disabled={pending}
                onClick={onArchive}
              >
                <Icon name={room.archived ? "ArchiveRestore" : "Archive"} />
              </button>
            </IconActionTooltip>
            <IconActionTooltip label="Channel options">
              <button
                type="button"
                className="channel-nav-action"
                aria-label={`${room.name} options`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
                onClick={(event) => openOptions(event.currentTarget)}
              >
                <Icon name="MoreHorizontal" />
              </button>
            </IconActionTooltip>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent id={menuId} aria-label={`${room.name} options`}>
        <ContextMenuItem onSelect={onRename}>
          <Icon name="Edit" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopyId}>
          <Icon name="Copy" />
          Copy channel ID
        </ContextMenuItem>
        <ContextMenuItem disabled={pending} onSelect={onArchive}>
          <Icon name={room.archived ? "ArchiveRestore" : "Archive"} />
          {room.archived ? "Restore" : "Archive"}
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={onDelete}
        >
          <Icon name="Trash2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
