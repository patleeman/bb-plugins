// The Studio frontend kit: the shared collection, item header, sidebar
// sections, and the pieces they are built from.
export {
  CollectionPage,
  itemKey,
  sortItems,
  toggleSelection,
  type ActionResults,
  type CollectionHandlers,
  type CollectionItem,
  type CollectionKind,
  type CollectionTag,
} from "./collection";
export { AddOnCollection, type ProviderCall } from "./add-on";
export { EditableTitle, ItemHeader } from "./item-header";
export { openAppPath, studioPath } from "./nav";
export {
  Badge,
  Checkbox,
  DANGER_BUTTON,
  EmptyState,
  FLOATING,
  FLOATING_BUTTON,
  GHOST_BUTTON,
  Highlight,
  ICON_BUTTON,
  ItemTile,
  OUTLINE_BUTTON,
  PageColumn,
  PILL,
  PRIMARY_BUTTON,
  projectName,
  THUMBNAIL,
  useProjects,
  type Project,
} from "./pieces";
export { usePluginPresent, useStudioChatPresent, useStudioPresent } from "./presence";
export { usePathname } from "./route";
export {
  SIDEBAR_ROW,
  SIDEBAR_ROW_SELECTED,
  SidebarAnchors,
  SidebarDisplayMenuItems,
  SidebarGroupHeading,
  SidebarNote,
  SidebarPortal,
  SidebarSection,
  showSidebarSection,
  useHiddenSidebarSections,
  useExpandSidebarSection,
  useSidebarDisplay,
  useSidebarHosted,
  useSidebarNavigated,
  type SidebarDirection,
  type SidebarDisplay,
  type SidebarSectionAction,
} from "./sidebar";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
export { Icon } from "../ui/icon";
export { cn } from "../ui/utils";
