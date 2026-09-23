import type { Bot, PermissionMode, Room } from "./contract";

export const permissionLabels: Record<PermissionMode, string> = {
  "accept-edits": "Accept Edits",
  auto: "Auto",
  full: "Full Access",
};
export const inheritLabel = "Each bot's own";
export const permissionOptions: {
  value: PermissionMode | null;
  label: string;
  hint: string;
}[] = [
  {
    value: null,
    label: inheritLabel,
    hint: "Use the mode set in every bot's profile",
  },
  {
    value: "accept-edits",
    label: permissionLabels["accept-edits"],
    hint: "Sandboxed, and asks you to approve anything beyond it",
  },
  {
    value: "auto",
    label: permissionLabels.auto,
    hint: "Sandboxed, and the provider reviews on its own",
  },
  {
    value: "full",
    label: permissionLabels.full,
    hint: "No sandbox and no approvals",
  },
];

/** What the trigger says: the channel's setting, or what its bots agree on. */
export function permissionSummary(
  room: Pick<Room, "permissionMode">,
  members: Pick<Bot, "permissionMode">[],
) {
  if (room.permissionMode) return permissionLabels[room.permissionMode];
  if (!members.length) return inheritLabel;
  const modes = new Set(members.map((b) => b.permissionMode));
  return modes.size === 1 ? permissionLabels[[...modes][0]!] : "Mixed";
}
