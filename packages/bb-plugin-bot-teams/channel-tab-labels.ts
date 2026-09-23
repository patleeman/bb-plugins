import type { PluginContentScriptRegistration } from "@get-bb/plugin-sdk/app";
import { workbenchLabels } from "./channel-workbench";

// BB's fixed tabs currently show only the plugin's shared branding icon. Reveal
// their existing accessible labels so these native tabs can be distinguished.
// Keep shell compatibility in a lifecycle-managed content script; the host still
// owns every button, selection, keyboard action, drag target, and split.
export const channelTabLabels: PluginContentScriptRegistration = {
  id: "channel-tab-labels",
  mount() {
    const scope = 'body:has(.channel-header) [aria-label="Right panel views"]';
    const buttons = Object.values(workbenchLabels)
      .map((label) => `button[aria-label=${JSON.stringify(label)}]`)
      .join(", ");
    const tab = `${scope} :is(${buttons}):has(> .sr-only)`;
    const style = document.createElement("style");
    style.textContent = `
      ${scope} { overflow-x: auto; scrollbar-width: thin; }
      ${tab} { padding-inline: 10px; }
      ${tab} > span:not(.sr-only) { display: none; }
      ${tab} > .sr-only {
        position: static;
        width: auto;
        height: auto;
        margin: 0;
        overflow: visible;
        clip: auto;
        clip-path: none;
        white-space: nowrap;
      }
    `;
    document.head.append(style);
    // BB dismisses the compact drawer when the route changes, but jumping to
    // the message already in the URL leaves it open. The SDK has no close API;
    // activate the owning drawer's native close control for channel jumps.
    const closeDrawerOnJump = (event: Event) => {
      const roomId = (event as CustomEvent<{ roomId: string }>).detail?.roomId;
      const panel = document.querySelector<HTMLElement>(".channel-workbench");
      if (!panel || panel.dataset.channelId !== roomId) return;
      panel.closest('[role="dialog"]')
        ?.querySelector<HTMLButtonElement>('button[aria-label^="Hide right panel"]')
        ?.click();
    };
    window.addEventListener("bb:bots:jump", closeDrawerOnJump);
    return () => {
      window.removeEventListener("bb:bots:jump", closeDrawerOnJump);
      style.remove();
    };
  },
};
