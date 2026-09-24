// BB's OptionPicker (apps/app pickers) — the muted trigger and checked menu
// used for the model, permission, and project pickers around the composer.
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "./coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { LIST_HOVER_TRANSITION } from "./motion";

export const OPTION_BASE_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center justify-start gap-1 px-1 text-xs leading-tight";
export const OPTION_INTERACTIVE_CLASS_NAME =
  "border-none bg-transparent shadow-none";
export const OPTION_MENU_CONTENT_CLASS_NAME = "w-max min-w-0 max-w-96";
export const OPTION_MUTED_CLASS_NAME =
  "text-muted-foreground hover:text-muted-foreground";

export interface PickerOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: string;
  disabled?: boolean;
}

export function OptionPicker<T extends string>({
  label,
  heading = label,
  note,
  value,
  options,
  onChange,
  className,
  caretClassName,
  contentClassName,
  muted,
  align = "start",
  side,
  icon,
  disabled,
  busy,
  trigger,
}: {
  label: string;
  /** Menu heading; defaults to the picker label. */
  heading?: string;
  /** Extra context under the heading. */
  note?: ReactNode;
  value: T;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  caretClassName?: string;
  contentClassName?: string;
  muted?: boolean;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom";
  /** Leading trigger icon; defaults to the selected option's icon. */
  icon?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Replaces the default labelled trigger, as in a split send button. */
  trigger?: ReactNode;
}) {
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? value;
  const leadingIcon = icon ?? selected?.icon;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${label}: ${selectedLabel}`}
          aria-busy={busy || undefined}
          disabled={disabled}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            LIST_HOVER_TRANSITION,
            muted && OPTION_MUTED_CLASS_NAME,
            disabled && "cursor-default disabled:opacity-100",
            className,
          )}
        >
          {leadingIcon ? (
            <Icon name={leadingIcon} className="size-3.5 shrink-0" />
          ) : null}
          <span
            className="min-w-0 truncate"
            title={
              selected?.description
                ? `${label}: ${selectedLabel} - ${selected.description}`
                : `${label}: ${selectedLabel}`
            }
          >
            {selectedLabel}
          </span>
          {disabled ? null : (
            <Icon
              name="ChevronDown"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground",
                caretClassName,
              )}
            />
          )}
        </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        align={align}
        side={side}
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, contentClassName)}
      >
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        {note ? (
          <p className="px-2 pb-1 text-xs leading-snug text-muted-foreground">
            {note}
          </p>
        ) : null}
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={option.value === value}
            disabled={option.disabled}
            onSelect={() => onChange(option.value)}
            className={cn(
              "flex items-start justify-between gap-3 whitespace-normal",
              LIST_HOVER_TRANSITION,
            )}
          >
            <span className="flex min-w-0 flex-1 items-start gap-2">
              {option.icon ? (
                <Icon
                  name={option.icon}
                  className="size-4 shrink-0 max-md:pointer-coarse:mt-0.5"
                />
              ) : null}
              <span className="min-w-0 flex-1">
                <span
                  className="block whitespace-normal break-words font-medium"
                  title={option.label}
                >
                  {option.label}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block whitespace-normal break-words text-xs leading-snug text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </span>
            <Icon
              name="Check"
              className={cn(
                COARSE_POINTER_ICON_SIZE_CLASS,
                "shrink-0",
                option.value === value ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
