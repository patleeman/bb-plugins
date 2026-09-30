import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { DIRECTIVE, PAGE_PANEL_ACTION } from "./src/explore/shared";
import { ExploreDirective } from "./src/ui/explore-rows";
import { PagePanel } from "./src/ui/PagePanel";
import { PagesPanel } from "./src/ui/PagesPanel";
import { ThreadPageLink } from "./src/ui/ThreadPageLink";
import { pageIdFromField, TALK_OPEN_FIELD_EVENT } from "./src/ui/talk";
import "./styles.css";

/** Opens a page when Talk's "Go back" asks for a dictation field of ours. */
function TalkBridge() {
  const navigate = useBbNavigate();
  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = pageIdFromField((event as CustomEvent<{ field?: unknown }>).detail?.field);
      if (!id) return;
      // Tells Talk the page is opening, so it doesn't fall back to copying.
      event.preventDefault();
      navigate.toPluginPanel("pages", { subPath: id });
    };
    window.addEventListener(TALK_OPEN_FIELD_EVENT, onOpen);
    return () => window.removeEventListener(TALK_OPEN_FIELD_EVENT, onOpen);
  }, [navigate]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "pages", title: "Pages", icon: "pages/pages", path: "pages", component: PagesPanel });
  app.slots.experimental_appOverlay({ id: "talk-bridge", component: TalkBridge });
  app.slots.experimental_threadHeaderAction({ id: "page-link", title: "Page", component: ThreadPageLink });
  // A page next to a thread: `{ pageId }`, or an Explore explainer with `{ explainerId }`.
  app.slots.threadPanelAction({ id: PAGE_PANEL_ACTION, title: "Page", icon: "pages/pages", layout: "flush", component: PagePanel });
  // Explore: "Along the way" findings at the end of a reply.
  app.slots.messageDirective({ id: DIRECTIVE, component: ExploreDirective });
});
