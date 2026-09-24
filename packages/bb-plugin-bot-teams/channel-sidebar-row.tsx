import { useId, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Room } from "./contract";
import { IconActionTooltip } from "./channel-controls";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
  approvalCount = 0,
  pending,
  onOpen,
  onMarkRead,
  onPin,
  onRename,
  onCopyLink,
  onCopyId,
  onArchive,
  onDelete,
  children,
}: {
  /** Bot DMs shown while this channel is selected. */
  children?: ReactNode;
  room: Room;
  selected: boolean;
  working: boolean;
  attentionCount?: number;
  /** Bot requests waiting for an approval or answer in this channel. */
  approvalCount?: number;
  pending: boolean;
  onOpen: () => void;
  onMarkRead: () => void;
  onPin: () => void;
  onRename: () => void;
  onCopyLink: () => void;
  onCopyId: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowLink = useRef<HTMLAnchorElement>(null);
  const menuId = useId();
  const hasUnread = room.updatedAt > (room.lastReadAt ?? 0);
  const unread = hasUnread && !selected;
  const openInSplit = () => {
    // BB's route anchor delegate handles modified plugin links with its split placement rules.
    rowLink.current?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      view: window,
    }));
  };
  const waitingLabel = [
    attentionCount > 0 &&
      `${attentionCount} ${attentionCount === 1 ? "request needs" : "requests need"} your attention`,
    approvalCount > 0 &&
      `${approvalCount} waiting for your approval`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
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
          <a
            ref={rowLink}
            href={`/plugins/bot-teams/channels/${room.id}`}
            className={`channel-nav-row ${unread ? "is-unread" : ""}`}
            aria-current={selected ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              onOpen();
            }}
          >
            {waitingLabel ? (
              <span className="channel-needs-attention" role="img"
                aria-label={waitingLabel}
                title={waitingLabel}>
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
          </a>
          <span className="channel-nav-actions">
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
        <ContextMenuItem onSelect={openInSplit}>
          <Icon name="PanelRight" />
          Open in split
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopyLink}>
          <Icon name="Link" />
          Copy channel link
        </ContextMenuItem>
        <ContextMenuItem disabled={pending} onSelect={onMarkRead}>
          <Icon name={hasUnread ? "MailOpen" : "Mail"} />
          {hasUnread ? "Mark read" : "Mark unread"}
        </ContextMenuItem>
        <ContextMenuItem disabled={pending} onSelect={onPin}>
          <Icon name="Pin" />
          {room.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRename}>
          <Icon name="Edit" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopyId}>
          <Icon name="Copy" />
          Copy channel ID
        </ContextMenuItem>
        <ContextMenuSeparator />
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
    {selected && children}
    </>
  );
}
