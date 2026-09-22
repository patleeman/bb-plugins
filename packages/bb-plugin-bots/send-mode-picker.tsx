import { useId } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import {
  sendModes,
  sendModeLabels,
  sendModeDescriptions,
  type SendMode,
} from "./send-mode";

export function SendModePicker({
  value,
  disabled,
  onChange,
}: {
  value: SendMode;
  disabled: boolean;
  onChange: (mode: SendMode) => void;
}) {
  const hintId = useId();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Send mode: ${sendModeLabels[value]}`}
          className="h-8 gap-1 px-2 text-xs text-muted-foreground"
        >
          <span>{sendModeLabels[value]}</span>
          <Icon name="ChevronDown" aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Send mode"
          align="end"
          side="top"
          sideOffset={4}
          collisionPadding={8}
          className="channel-popover channel-mode-menu"
        >
          <DropdownMenu.Label className="channel-menu-label">
            Send this message
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as SendMode)}
          >
            {sendModes.map((mode) => (
              <DropdownMenu.RadioItem
                key={mode}
                value={mode}
                className="channel-menu-row"
                textValue={sendModeLabels[mode]}
                aria-describedby={`${hintId}-${mode}`}
              >
                <span className="channel-mode-mark" aria-hidden>
                  <DropdownMenu.ItemIndicator>
                    <Icon name="Check" />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="channel-bot-name">
                  {sendModeLabels[mode]}
                  <small id={`${hintId}-${mode}`}>
                    {sendModeDescriptions[mode]}
                  </small>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
