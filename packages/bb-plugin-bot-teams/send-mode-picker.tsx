import { OptionPicker } from "./components/ui/option-picker";
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

/** Sits beside the + menu, where a thread composer keeps its model picker. */
export function SendModePicker({
  value,
  smart,
  disabled,
  onChange,
}: {
  value: SendMode;
  /** Smart channels only show the menu for an override; Auto hides it again. */
  smart?: boolean;
  disabled: boolean;
  onChange: (mode: SendMode) => void;
}) {
  return (
    <OptionPicker
      label="Send mode"
      heading="Send this message"
      note={
        smart ? "Auto returns this message to Smart classification." : undefined
      }
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      className="max-md:pointer-coarse:h-10"
      contentClassName="max-w-72"
    />
  );
}
