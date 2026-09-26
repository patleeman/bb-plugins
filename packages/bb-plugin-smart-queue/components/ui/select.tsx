// Vendored subset of BB shared-ui/select with SDK icons and plugin-local utils.
import * as React from "react";
import * as Primitive from "@radix-ui/react-select";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion";

export const Select = Primitive.Root;
export const SelectValue = Primitive.Value;
export const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof Primitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <Primitive.Trigger
    ref={ref}
    className={cn(
      `flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm ${CONTROL_HOVER_TRANSITION} focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate`,
      className,
    )}
    {...props}
  >
    {children}
    <Primitive.Icon asChild>
      <Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
    </Primitive.Icon>
  </Primitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";
export function SelectContent({ children }: { children: React.ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        position="popper"
        sideOffset={4}
        className="relative z-[70] max-h-96 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
      >
        <Primitive.ScrollUpButton className="flex justify-center py-1">
          <Icon name="ChevronUp" className="size-4" />
        </Primitive.ScrollUpButton>
        <Primitive.Viewport className="max-h-80 w-full min-w-[var(--radix-select-trigger-width)] p-1">
          {children}
        </Primitive.Viewport>
        <Primitive.ScrollDownButton className="flex justify-center py-1">
          <Icon name="ChevronDown" className="size-4" />
        </Primitive.ScrollDownButton>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export function SelectItem({
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <Primitive.ItemIndicator>
          <Icon name="Check" className="size-4" />
        </Primitive.ItemIndicator>
      </span>
      <Primitive.ItemText>{children}</Primitive.ItemText>
    </Primitive.Item>
  );
}
