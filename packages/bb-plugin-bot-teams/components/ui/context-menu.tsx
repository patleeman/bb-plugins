// Vendored subset of BB's shared-ui context menu, using the same Radix
// primitives, menu sizing, colors, and stacking layer.
import * as React from "react";
import * as Primitive from "@radix-ui/react-context-menu";
import { cn } from "../../lib/utils";
import { LIST_HOVER_TRANSITION } from "./motion";

export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;

export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        className={cn(
          "z-[70] min-w-28 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0",
        LIST_HOVER_TRANSITION,
        className,
      )}
      {...props}
    />
  );
}
