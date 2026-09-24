import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { OptionPicker } from "./components/ui/option-picker";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import {
  sendModes,
  sendModeLabels,
  sendModeDescriptions,
  type SendMode,
} from "./send-mode";

const options = sendModes.map((mode) => ({
  value: mode,
  label: sendModeLabels[mode],
  description: sendModeDescriptions[mode],
}));

/** The caret beside Send, where a thread keeps its own send options. */
export function SendModeMenu({
  value,
  hasInput,
  disabled,
  onChange,
}: {
  value: SendMode;
  /** Matches the filled or outlined send button it is joined to. */
  hasInput: boolean;
  disabled: boolean;
  onChange: (mode: SendMode) => void;
}) {
  return (
    <OptionPicker
      label="Send mode"
      heading="Send this message"
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      align="end"
      side="top"
      contentClassName="max-w-72"
      trigger={
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Send mode: ${sendModeLabels[value]}`}
          disabled={disabled}
          className={cn(
            "relative w-7 rounded-l-none px-0 before:absolute before:left-0 before:top-1/2 before:h-3 before:w-px before:-translate-y-1/2 [&_[data-icon-root]]:size-2.5 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-9",
            hasInput ? "before:bg-background/25" : "before:bg-border",
          )}
        >
          <Icon name="ChevronDown" className="opacity-80" />
        </Button>
      }
    />
  );
}

/** Shown beside the + menu only while a message overrides the classifier. */
export function SendModeOverride({
  value,
  disabled,
  onChange,
}: {
  value: SendMode;
  disabled: boolean;
  onChange: (mode: SendMode) => void;
}) {
  return (
    <OptionPicker
      label="Send mode"
      heading="Send this message"
      note="Auto returns this message to the classifier."
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      className="max-md:pointer-coarse:h-10"
      contentClassName="max-w-72"
    />
  );
}
